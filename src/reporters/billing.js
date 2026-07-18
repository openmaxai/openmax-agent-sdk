/**
 * Org LLM billing/credit gate.
 *
 * When an org's LLM is suspended for credit arrears (欠费), a user message must
 * NOT be forwarded to the runtime — forwarding would wake the LLM and, because
 * billing is metered post-hoc (deducted after the call), let the org run
 * further into the negative. Credit arrears does NOT drop the WS: the agent
 * stays online and keeps receiving frames; only the LLM call is blocked at the
 * gateway. So the intercept lives in the bridge, between "message accepted for
 * handling" and "forward to the runtime".
 *
 * Authoritative signal: cws-core BFF `GET /api/v1/billing/plan-state`. Its body
 * carries `usage_snapshot.enforcement_suspended` (bool) — true while the org's
 * LLM is currently stopped for non-payment. We query it THROUGH the per-org
 * authed cws-core client (getForOrg), never directly against billing.
 *
 * FAIL-OPEN: any error (network, non-200, missing field, malformed body) is
 * treated as "not suspended" so a billing-query hiccup can never silently
 * black-hole a user's messages. The gateway remains the hard enforcement
 * boundary (it blocks the actual LLM call regardless) — this bridge check is a
 * UX affordance that turns a would-be silent no-op into an explicit notice.
 *
 * Result is cached per org_id for a short TTL so a chatty conversation doesn't
 * hammer plan-state on every inbound frame.
 *
 * ORIGIN GUARD (external agents are exempt): credit-arrears enforcement is
 * applied via billing → agent-manager → DisableApiKeys → gateway, which only
 * affects PLATFORM-MANAGED agents. EXTERNAL agents (self-hosted, bringing their
 * own LLM key) have no agent-manager record, so the org-level
 * `enforcement_suspended` flag can read true while their LLM still works — the
 * gate would false-block them. So before consulting plan-state we resolve the
 * agent's origin (`agent_origin` off `GET /api/v1/members/{self.member_id}`)
 * and only proceed for `platform_created`. `external_invited` or an unknown /
 * unresolved origin fails open (returns "not suspended"), never blocking. The
 * origin is immutable (set once at member creation) so it is cached PERMANENTLY
 * per org_id once a definitive value is obtained.
 *
 * Extraction notes (ported from zylos-openmax src/lib/billing-status.js):
 *   - The old `import { getForOrg, apiPath } from './client.js'` and
 *     `import { loadConfig } from './config.js'` module-global defaults are
 *     GONE. `deps.getForOrg` (or `deps.http.getForOrg`) and `deps.apiPath` (or
 *     `deps.http.apiPath`, else the default `/api/v1` prefix) supply the REST
 *     path; a missing getForOrg surfaces through the existing fail-open catch.
 *   - Config-driven overrides (plan_state_ttl_ms / overdue_notice_throttle_ms)
 *     read through an injected `deps.loadConfig` (default `() => ({})`).
 */

/** Default cws-core API prefix, mirroring CwsHttpClient.apiPath / COCO_API_PREFIX. */
const defaultApiPath = (p) => `/api/v1${p}`;

// Default plan-state cache TTL. Overridable via config.billing.plan_state_ttl_ms.
export const PLAN_STATE_TTL_MS = 30_000;

// Hard timeout on the plan-state query. cws-core sits behind the WS the agent
// already depends on, but a stalled BFF must never wedge the inbound pipeline —
// so we race the query against this deadline and fail-open on expiry. No retry.
export const PLAN_STATE_TIMEOUT_MS = 800;

// Hard timeout on the agent-origin member lookup — mirrors the plan-state
// deadline so a stalled /members BFF call can never wedge the inbound pipeline.
export const AGENT_ORIGIN_TIMEOUT_MS = 800;

// org_id → { value: boolean, ts: number(ms) }. Exported for tests.
export const planStateCache = new Map();

// org_id → agent_origin string ('platform_created' | 'external_invited').
// PERMANENT cache (NO TTL): agent_origin is immutable. Only definitive values
// are stored — a lookup error / missing member_id / absent field is NOT cached.
export const agentOriginCache = new Map();

// User-facing notice sent when the org's LLM is suspended for arrears. Bilingual
// (zh + en) on separate lines — sent verbatim every time, no per-user locale
// detection.
export const OVERDUE_NOTICE =
  '当前工作区积分已用尽，请充值后继续。\n' +
  'This workspace has run out of AI credits. Please top up to continue.';

// Overdue-notice throttle window. A suspended org always has its message
// dropped, but the notice is sent at most once per this window per reply target
// so a chatty sender isn't spammed. Overridable via
// config.billing.overdue_notice_throttle_ms.
export const OVERDUE_NOTICE_THROTTLE_MS = 5 * 60 * 1000;   // 300_000

// `${org_id}:${target}` → last-sent epoch ms. Exported for tests. Bounded by a
// prune-on-cap guard (see shouldSendOverdueNotice).
export const overdueNoticeCache = new Map();
const OVERDUE_NOTICE_MAX_ENTRIES = 3000;

/** Read a positive-integer config override via the injected loadConfig; else null. */
function configuredInt(loadConfig, path) {
  try {
    const cfg = (loadConfig || (() => ({})))();
    let v = cfg?.billing;
    for (const k of path) v = v?.[k];
    if (Number.isInteger(v) && v > 0) return v;
  } catch { /* fall through */ }
  return null;
}

function resolveTtlMs(loadConfig) {
  return configuredInt(loadConfig, ['plan_state_ttl_ms']) ?? PLAN_STATE_TTL_MS;
}

function resolveNoticeThrottleMs(loadConfig) {
  return configuredInt(loadConfig, ['overdue_notice_throttle_ms']) ?? OVERDUE_NOTICE_THROTTLE_MS;
}

/** Resolve { getForOrg, apiPath } from deps (explicit wins, else http, else default apiPath). */
function resolveHttpDeps(deps) {
  const http = deps.http || null;
  const getForOrg = deps.getForOrg || (http ? http.getForOrg.bind(http) : null);
  const apiPath = deps.apiPath || (http ? http.apiPath.bind(http) : defaultApiPath);
  return { getForOrg, apiPath };
}

/**
 * Throttle gate for the overdue notice. Returns true — and records the send —
 * when a notice should be sent for this (org_id + reply target) now; returns
 * false while still inside the throttle window. The message is dropped either
 * way; this only gates the user-facing notice send.
 *
 * @param {string} orgId
 * @param {string} target  reply target (conversation id) — DM and group get
 *        separate buckets.
 * @param {object} [deps]  test seam — { now, windowMs, loadConfig }.
 * @returns {boolean}
 */
export function shouldSendOverdueNotice(orgId, target, deps = {}) {
  const now = deps.now ? deps.now() : Date.now();
  const windowMs = Number.isInteger(deps.windowMs) ? deps.windowMs : resolveNoticeThrottleMs(deps.loadConfig);
  const key = `${orgId}:${target}`;
  const last = overdueNoticeCache.get(key);
  if (last != null && (now - last) < windowMs) return false;
  overdueNoticeCache.set(key, now);
  if (overdueNoticeCache.size > OVERDUE_NOTICE_MAX_ENTRIES) {
    for (const [k, ts] of overdueNoticeCache) {
      if ((now - ts) >= windowMs) overdueNoticeCache.delete(k);
    }
  }
  return true;
}

/**
 * Resolve this agent's origin for the given org.
 *
 * Reads `agent_origin` off `GET /api/v1/members/{orgConfig.self.member_id}`
 * through the per-org authed cws-core client (getForOrg unwraps the D8
 * envelope; we also tolerate a non-unwrapped `body.data.agent_origin`).
 *
 * @param {{org_id?: string, self?: {member_id?: string}}} orgConfig
 * @param {object} [deps]  test seam — { getForOrg, http, apiPath, warn, timeoutMs }.
 * @returns {Promise<'platform_created'|'external_invited'|null>}
 */
export async function resolveAgentOrigin(orgConfig, deps = {}) {
  const orgId = orgConfig?.org_id;
  const warn = deps.warn || ((...a) => console.warn('[billing-status]', ...a));
  const label = orgId || '?';
  const timeoutMs = Number.isInteger(deps.timeoutMs) ? deps.timeoutMs : AGENT_ORIGIN_TIMEOUT_MS;

  // Serve the permanent cache first (immutable origin).
  if (orgId && agentOriginCache.has(orgId)) return agentOriginCache.get(orgId);

  const memberId = orgConfig?.self?.member_id;
  if (!orgId || !memberId) {
    warn(`[${label}] cannot resolve agent origin: missing org_id or self.member_id`);
    return null;
  }

  const { getForOrg: getFor, apiPath } = resolveHttpDeps(deps);
  let body;
  try {
    // Race the member lookup against a hard deadline — no retry. On expiry we
    // treat origin as unknown (return null, NOT cached) so the next inbound
    // frame re-queries; a null origin fails open in isOrgLLMSuspended.
    const TIMED_OUT = Symbol('agent-origin-timeout');
    let timer;
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
    });
    let result;
    try {
      result = await Promise.race([getFor(orgId, apiPath(`/members/${memberId}`)), deadline]);
    } finally {
      clearTimeout(timer);
    }
    if (result === TIMED_OUT) {
      warn(`[${label}] member lookup for agent origin timed out after ${timeoutMs}ms, treating origin as unknown`);
      return null; // NOT cached
    }
    body = result;
  } catch (err) {
    // Do NOT cache: retry on the next message until a definitive value lands.
    warn(`[${label}] member lookup for agent origin failed, treating origin as unknown: ${err?.message || err}`);
    return null;
  }

  const origin = body?.agent_origin ?? body?.data?.agent_origin ?? null;
  if (origin !== 'platform_created' && origin !== 'external_invited') {
    warn(`[${label}] agent_origin absent or unrecognized on member ${memberId}; treating origin as unknown`);
    return null;
  }

  agentOriginCache.set(orgId, origin); // permanent — origin is immutable
  return origin;
}

/**
 * Is this org's LLM currently suspended for credit arrears?
 *
 * @param {{org_id?: string, self?: {member_id?: string}}} orgConfig
 * @param {object} [deps]  test seam — { getForOrg, http, apiPath, now, ttlMs,
 *        timeoutMs, loadConfig, warn }.
 * @returns {Promise<boolean>}  true only when the agent is `platform_created`
 *        AND plan-state affirmatively reports enforcement_suspended.
 */
export async function isOrgLLMSuspended(orgConfig, deps = {}) {
  const orgId = orgConfig?.org_id;
  if (!orgId) return false;

  const { getForOrg: getFor, apiPath } = resolveHttpDeps(deps);
  const now = deps.now ? deps.now() : Date.now();
  const ttl = Number.isInteger(deps.ttlMs) ? deps.ttlMs : resolveTtlMs(deps.loadConfig);
  const timeoutMs = Number.isInteger(deps.timeoutMs) ? deps.timeoutMs : PLAN_STATE_TIMEOUT_MS;
  const warn = deps.warn || ((...a) => console.warn('[billing-status]', ...a));
  const label = orgId || '?';

  // Origin guard: resolve origin FIRST and fail open (allow through) unless it
  // is POSITIVELY platform_created. Threads the same getForOrg + apiPath + warn.
  const origin = await resolveAgentOrigin(orgConfig, { getForOrg: getFor, apiPath, warn, timeoutMs: deps.timeoutMs });
  if (origin !== 'platform_created') return false;

  const cached = planStateCache.get(orgId);
  if (cached && (now - cached.ts) < ttl) return cached.value;

  let body;
  try {
    // Race the query against a hard deadline — no retry. On timeout we treat
    // the org as NOT suspended (fail-open) and do NOT cache that result.
    const TIMED_OUT = Symbol('plan-state-timeout');
    let timer;
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
    });
    let result;
    try {
      result = await Promise.race([getFor(orgId, apiPath('/billing/plan-state')), deadline]);
    } finally {
      clearTimeout(timer);
    }
    if (result === TIMED_OUT) {
      warn(`[${label}] plan-state query timed out after ${timeoutMs}ms, treating as not suspended`);
      return false; // fail-open, NOT cached
    }
    body = result;
  } catch (err) {
    // FAIL-OPEN: never block a message because billing could not be queried.
    warn(`[${label}] plan-state query failed, treating as not suspended: ${err?.message || err}`);
    return false;
  }

  const snapshot = body?.usage_snapshot ?? body?.data?.usage_snapshot;
  const value = snapshot?.enforcement_suspended === true;
  planStateCache.set(orgId, { value, ts: now });
  return value;
}
