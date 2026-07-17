/**
 * Runtime-metrics reporter — merges runtime state with container-scoped cgroup
 * gauges and PUTs a single snapshot to cws-core
 * (`PUT /api/v1/agents/{member_id}/runtime-metrics`) on a periodic tick driven
 * by the orchestrator/adapter.
 *
 * Extraction notes (from zylos-openmax `src/lib/metrics-reporter.js`):
 *   The original sourced runtime state from a LOCAL zylos-dashboard
 *   (`/api/state`), with a whole dashboard-auth apparatus bolted on — session-
 *   token exchange, `zylos_ak_...` api-key auto-provisioning via the dashboard
 *   CLI, config.json write-back. ALL of that is Zylos-specific data SOURCING,
 *   not agent-level reporting, so per design §3.3 it moves behind the injected
 *   `RuntimeStateProvider.getMetrics()`. This SDK module keeps only the
 *   runtime-agnostic REPORTING wrapper:
 *     - sample + merge the cgroup gauges (container-correct CPU/mem when
 *       containerized; else fall back to the runtime-state figures),
 *     - build the runtime-metrics payload,
 *     - select the PRIMARY org (first enabled org) and PUT once (not per-org),
 *     - once-guard the runtime-metrics 404 (older cws-core without the endpoint).
 *   HTTP goes through the injected `CwsHttpClient`; the dashboard localhost
 *   fetch / api-key CLI / config write-back are GONE from the SDK.
 *
 * The `getMetrics()` return shape mirrors the old dashboard `/api/state` body
 * the payload builder consumed:
 *   { system_metrics:{cpu_pct,mem_pct,mem_total_bytes,mem_used_bytes,disk_pct,
 *                     disk_free_bytes},
 *     runtime_info:{model_id,model,effort},
 *     state, context_pct, session_cost, daily_cost, weekly_cost, rate_limit_pct }
 * A null / empty return degrades gracefully (nothing is reported that tick) —
 * consistent with the discipline that a reporter failure never breaks the
 * message main chain.
 */

import { consoleLogger } from '../providers.js';
import { createCgroupCollector } from './cgroup.js';

/**
 * Resolve the PRIMARY org to self-report under: the first entry of the
 * insertion-ordered `activeOrgConfigs` Map (the first enabled org). Returns
 * `{ slug, orgConfig, selfMemberId }` (selfMemberId may be undefined when the
 * primary org has no `self.member_id`), or `null` when no org is active.
 */
export function selectPrimaryOrg(activeOrgConfigs) {
  const [primary] = activeOrgConfigs;
  if (!primary) return null;
  const [slug, orgConfig] = primary;
  return { slug, orgConfig, selfMemberId: orgConfig.self?.member_id };
}

/**
 * Build the runtime-metrics payload from runtime state + cgroup gauges.
 *
 * Resource sourcing depends on whether we're in a container:
 *   - Containerized (cgroup v1/v2): CPU + memory come from the cgroup collector
 *     — the container's real quota/consumption, not node-level figures.
 *   - Not in a cgroup (cgroup_version "none"): no container quota to read, so
 *     fall back to ALL metrics from the runtime state (node-level, best
 *     available — beats reporting null).
 *   Disk always comes from the runtime state (its statfs on the volume mount is
 *   already the correct container scope).
 *
 * @returns {object|null} payload, or null when `state` is missing/falsy.
 */
export function buildPayload(state, cg, version = '0.0.0') {
  if (!state) return null;
  const sys = state.system_metrics || {};
  const rt = state.runtime_info || {};
  const containerized = cg.cgroup_version !== 'none';
  return {
    version,
    resources: {
      cpu_pct: containerized ? (cg.cpu_pct ?? null) : (sys.cpu_pct ?? null),
      mem_pct: containerized ? (cg.mem_pct ?? null) : (sys.mem_pct ?? null),
      mem_total_bytes: containerized ? (cg.mem_total_bytes ?? null) : (sys.mem_total_bytes ?? null),
      mem_used_bytes: containerized ? (cg.mem_used_bytes ?? null) : (sys.mem_used_bytes ?? null),
      disk_pct: sys.disk_pct ?? null,
      disk_free_bytes: sys.disk_free_bytes ?? null,
    },
    runtime: {
      state: state.state ?? 'UNKNOWN',
      model_id: rt.model_id ?? null,
      model: rt.model ?? null,
      context_pct: state.context_pct ?? null,
      effort: rt.effort ?? null,
    },
    cost: {
      session: state.session_cost ?? null,
      daily: state.daily_cost ?? null,
      weekly: state.weekly_cost ?? null,
    },
    rate_limit_pct: state.rate_limit_pct ?? null,
  };
}

/** A runtime-state object is "usable" when it's a non-empty object. */
function hasState(state) {
  return !!state && typeof state === 'object' && Object.keys(state).length > 0;
}

/**
 * @param {Map<string, object>|Iterable<[string,object]>} activeOrgConfigs
 *        insertion-ordered org map; the first entry is the primary report target.
 * @param {object} deps
 * @param {import('../transport/http.js').CwsHttpClient} deps.http  cws-core client
 * @param {import('../providers.js').RuntimeStateProvider} [deps.runtimeState]
 *        source of the dashboard-shaped runtime state; when absent/empty the
 *        tick reports nothing (degraded).
 * @param {import('../providers.js').Logger} [deps.logger]
 * @param {{sample:Function, read:Function}} [deps.cgroup]  cgroup collector (default real)
 * @param {string} [deps.version]  the agent app version reported as top-level `version`
 * @param {Function} [deps.putForOrg]  override (else http.putForOrg)
 * @param {Function} [deps.apiPath]    override (else http.apiPath)
 * @returns {() => Promise<void>}  the periodic reporter
 */
export function createMetricsReporter(activeOrgConfigs, {
  http,
  runtimeState,
  logger = consoleLogger,
  cgroup = createCgroupCollector(),
  version = '0.0.0',
  putForOrg,
  apiPath,
} = {}) {
  const put = putForOrg || (http ? http.putForOrg.bind(http) : null);
  const ap = apiPath || (http ? http.apiPath.bind(http) : null);
  if (!put || !ap) {
    throw new Error('createMetricsReporter requires a CwsHttpClient (http) or explicit putForOrg + apiPath');
  }
  const log = (...a) => logger?.info?.(...a);
  const warn = (...a) => logger?.warn?.(...a);

  let warnedEndpoint404 = false;      // cws-core runtime-metrics endpoint missing
  let warnedStateUnavailable = false; // runtime state fetch failing — re-armed on success
  let loggedCgroupFallback = false;   // logged once when cgroup is absent (non-containerized)

  return async function reportMetrics() {
    // Sample CPU every tick — cumulative usage_usec needs a differential window,
    // and sampling unconditionally (before the state fetch, which can fail)
    // keeps the window evenly spaced across state outages.
    cgroup.sample();

    let state = null;
    try {
      state = runtimeState ? await runtimeState.getMetrics() : null;
    } catch (err) {
      state = null;
      if (!warnedStateUnavailable) {
        warnedStateUnavailable = true;
        warn(`runtime state unavailable (${err?.message || 'fetch failed'}) — runtime-metrics not reported`);
      }
      return;
    }
    if (!hasState(state)) {
      if (!warnedStateUnavailable) {
        warnedStateUnavailable = true;
        warn('runtime state unavailable — runtime-metrics not reported this tick');
      }
      return;
    }
    warnedStateUnavailable = false; // recovered — re-arm the once-guard

    const cg = cgroup.read();
    if (cg.cgroup_version === 'none' && !loggedCgroupFallback) {
      loggedCgroupFallback = true;
      log('cgroup unavailable (non-containerized agent) — reporting node-level CPU/memory from runtime state');
    }
    const payload = buildPayload(state, cg, version);
    if (!payload) return;

    // Report to the PRIMARY org only (the first enabled org) — a single PUT.
    const primary = selectPrimaryOrg(activeOrgConfigs);
    if (!primary) {
      warn('no active org configured — runtime-metrics not reported');
      return;
    }
    const { slug, orgConfig, selfMemberId } = primary;
    if (!selfMemberId) {
      warn(`[${slug}] primary org has no self.member_id — runtime-metrics not reported`);
      return;
    }
    try {
      await put(orgConfig.org_id, ap(`/agents/${selfMemberId}/runtime-metrics`), payload);
    } catch (err) {
      if (err.status === 404) {
        if (!warnedEndpoint404) {
          warn(`[${slug}] runtime-metrics endpoint not available (404), skipping`);
          warnedEndpoint404 = true;
        }
      } else {
        warn(`[${slug}] metrics report failed: ${err.message}`);
      }
    }
  };
}
