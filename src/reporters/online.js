/**
 * Agent online self-report — onboarding trigger signal (cws-core C1).
 *
 * Once per process per org, tell cws-core this agent instance is up:
 * POST /api/v1/agents/{member_id}/online-report. cws-core uses the report as
 * its onboarding trigger signal, gated entirely server-side (platform switch,
 * org's-first-active-agent check, session state) — so repeated reports across
 * restarts are expected input, not errors. A failed report never affects
 * messaging: callers retry on the next WS (re)connect and on the periodic
 * sync tick until one attempt succeeds.
 *
 * Note on `not_first_agent` / primary-org semantics: the report is a pure
 * trigger — the response `{ triggered, reason }` tells the caller whether THIS
 * report actually started onboarding. cws-core decides that server-side (e.g.
 * `reason:"not_first_agent"` when the org already had an active agent, so this
 * one does not re-trigger onboarding). The SDK never interprets the reason; it
 * marks the org `done` on any success and moves on.
 *
 * Deps are injected so the report logic is unit-testable without a live
 * comm-bridge daemon (see online.test.js). Ported from
 * zylos-openmax `src/lib/online-report.js`: the old `postForOrg` / `apiPath`
 * came from client.js; here they are derived from an injected `CwsHttpClient`
 * (`deps.http`) or supplied directly. `loadConfig` (the fresh-install member_id
 * write-back re-read) is injected by the adapter; it defaults to `() => ({})`.
 */

export function createOnlineReporter({
  http,
  postForOrg,
  apiPath,
  loadConfig = () => ({}),
  log = () => {},
  warn = () => {},
} = {}) {
  const post = postForOrg || (http ? http.postForOrg.bind(http) : null);
  const ap = apiPath || (http ? http.apiPath.bind(http) : null);
  if (!post || !ap) {
    throw new Error('createOnlineReporter requires a CwsHttpClient (http) or explicit postForOrg + apiPath');
  }

  const done = new Set();     // org ids reported (or permanently skipped) this process
  const inflight = new Set(); // guard against a reconnect racing an in-flight POST

  return async function reportAgentOnline(orgConfig) {
    if (done.has(orgConfig.org_id) || inflight.has(orgConfig.org_id)) return;

    let memberId = orgConfig.self?.member_id;
    if (!memberId) {
      // Fresh install: the first token exchange writes member_id back through
      // the adapter's config layer, which clones and replaces the config object
      // — the boot-captured orgConfig never sees it. Re-resolve from the live
      // config and fill the captured object in place so later reads are
      // consistent.
      memberId = loadConfig().orgs?.[orgConfig.org_id]?.self?.member_id || '';
      if (!memberId) return; // write-back hasn't landed yet — retried on reconnect / periodic sync
      orgConfig.self = { ...(orgConfig.self || {}), member_id: memberId };
    }

    inflight.add(orgConfig.org_id);
    try {
      const res = await post(orgConfig.org_id, ap(`/agents/${memberId}/online-report`));
      done.add(orgConfig.org_id);
      log(`[${orgConfig.org_id}] online-report: triggered=${res?.triggered === true}${res?.reason ? ` reason=${res.reason}` : ''}`);
    } catch (err) {
      if (err?.status === 404) {
        // Endpoint not on this cws-core (older deployment) — warn once and stop
        // retrying for the process.
        done.add(orgConfig.org_id);
        warn(`[${orgConfig.org_id}] online-report endpoint not available (404), skipping`);
        return;
      }
      throw err;
    } finally {
      inflight.delete(orgConfig.org_id);
    }
  };
}
