/**
 * Startup readiness barrier for the agent's authoritative display_name.
 *
 * Group @-mention detection for cws-comm-native messages is plain-text only
 * (`@<display_name>`, no structured mentions[]), so the name we match against
 * MUST be the authoritative per-org display_name from cws-core — a stale or
 * empty hand-configured `self.name` silently drops real @s. That name is
 * populated by syncOwnerFromCore's self-member read, which historically only
 * ran on the 5-minute periodic sync (no runOnStart): on a fresh start/upgrade
 * the WS connected, replayed queued messages, and dropped @s for up to one
 * full sync interval — the exact incident this barrier closes.
 *
 * The hydrator returned here is the explicit readiness step. Callers place it
 * at two structural points where nothing can race the message pipeline:
 *   1. the awaited pre-connect bootstrap (before startOrgWs creates WsClient);
 *   2. the WsClient urlProvider, which ws.js awaits BEFORE the socket object
 *      exists — so neither live frames nor the onOpen replay can be dispatched
 *      until the hydrate attempt has resolved, on every initial connect AND
 *      every reconnect. (Awaiting inside onOpen would NOT be a barrier:
 *      WsClient fires onOpen unawaited and dispatches 'message' independently.)
 *
 * Each attempt: acquire the org JWT (its exchange writes self.member_id back
 * to config.json on fresh installs) → backfill member_id into the captured
 * orgConfig from live config → run the authoritative self-member sync.
 * Readiness = that sync explicitly reported `nameReady` (member record read
 * from core; any display_name it carried is applied before it returns).
 *
 * Bounded fail-open, never throws, never hangs: after maxAttempts with
 * exponential backoff we proceed — with the persisted last-known display_name
 * when one exists (still authoritative, just possibly stale), else with a loud
 * warning that matching is degraded to the configured self.name until the next
 * reconnect / periodic sync heals it. Rationale: a hard gate would keep the
 * org fully offline through any transient core outage at boot; and since the
 * ws-ticket comes from the same core, a connection that CAN be established
 * almost always implies the sync could succeed too — the fail-open window is
 * the narrow partial-failure case where availability wins, loudly.
 *
 * Success is sticky per org for the process lifetime (display_name persists in
 * memory), so the urlProvider call is a no-op Set lookup on later reconnects.
 * Deps are injected so the barrier is unit-testable without the comm-bridge
 * daemon (see self-name-hydration.test.js).
 */

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createSelfNameHydrator({
  acquireToken,   // async (orgConfig) → void; JWT exchange (writes back self.member_id)
  syncSelf,       // async (orgConfig) → { nameReady, reason? }; authoritative self-member sync
  loadConfig,     // () → live config (for the member_id write-back backfill)
  log,
  warn,
  sleep = defaultSleep,
  maxAttempts: defaultMaxAttempts = 3,
  retryDelayMs: defaultRetryDelayMs = 2000,
}) {
  const synced = new Set(); // org slugs with a successful authoritative sync this process

  return async function hydrateSelfName(orgConfig, { maxAttempts = defaultMaxAttempts, retryDelayMs = defaultRetryDelayMs } = {}) {
    const slug = orgConfig.slug;
    if (synced.has(slug)) {
      return { ready: true, source: 'already', displayName: orgConfig.self?.display_name || '' };
    }

    let delay = retryDelayMs;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      // (1) JWT — non-fatal on its own, but the sync below can't succeed
      // without it; a failure here surfaces as `nameReady: false` and retries.
      try {
        await acquireToken(orgConfig);
      } catch (err) {
        warn(`[${slug}] self-name hydrate: JWT acquire failed (attempt ${attempt}/${maxAttempts}): ${err.message}`);
      }

      // (2) Fresh install: token.exchange writes member_id back through
      // updateConfig, which replaces the config object — the boot-captured
      // orgConfig never sees it. Re-resolve from live config and backfill in
      // place (same pattern as online-report.js).
      if (!orgConfig.self?.member_id) {
        const liveMemberId = loadConfig().orgs?.[slug]?.self?.member_id || '';
        if (liveMemberId) orgConfig.self = { ...(orgConfig.self || {}), member_id: liveMemberId };
      }

      // (3) Authoritative self-member read. Must report readiness explicitly —
      // "no member_id yet" and "fetch failed" are NOT ready, not silent success.
      try {
        const res = await syncSelf(orgConfig);
        if (res?.nameReady) {
          synced.add(slug);
          const displayName = orgConfig.self?.display_name || '';
          log(`[${slug}] self display_name ready before connect${displayName ? ` ("${displayName}")` : ' (core reports no display_name — matching uses configured self.name)'}`);
          return { ready: true, source: 'core', displayName };
        }
        warn(`[${slug}] self-name hydrate attempt ${attempt}/${maxAttempts} not ready: ${res?.reason || 'unknown'}`);
      } catch (err) {
        warn(`[${slug}] self-name hydrate attempt ${attempt}/${maxAttempts} failed: ${err.message}`);
      }

      if (attempt < maxAttempts) {
        await sleep(delay);
        delay *= 2;
      }
    }

    // Bounded fallback — do not deadlock the connection on a core outage.
    const cached = orgConfig.self?.display_name || '';
    if (cached) {
      warn(`[${slug}] self-name hydrate exhausted ${maxAttempts} attempt(s) — proceeding with cached last-known display_name "${cached}"; next reconnect / periodic sync retries`);
      return { ready: true, source: 'cache', displayName: cached };
    }
    warn(`[${slug}] SELF-NAME NOT HYDRATED after ${maxAttempts} attempt(s) and no cached display_name — plain-text @-mentions match only the configured self.name until the next reconnect / periodic owner-sync succeeds`);
    return { ready: false, source: 'none', displayName: '' };
  };
}
