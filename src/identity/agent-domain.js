/**
 * Self public base-URL resolution for the agent.
 *
 * Webhook-style channels (WhatsApp Business / LINE / Teams) need the agent to
 * know its OWN publicly-reachable base URL so it can construct callback/webhook
 * URLs. This module implements the two-tier resolution order (TM 79ad2910):
 *
 *   1. cws-core  — GET /api/v1/platform-agents/{identity_id}/domain returns the
 *      domain bound to this agent (`{full_domain, label, root_suffix}`).
 *      base_url = "https://" + full_domain.
 *   2. env       — ONLY if the agent has no bound domain (core responds 404),
 *      fall back to the AGENT_PUBLIC_BASE_URL environment variable.
 *
 * If neither yields a value → `{ ok:false, error }`.
 *
 * Strict semantics: the 404 is the ONE condition that reaches the env tier.
 * Any other HTTP/network error propagates, and a malformed 200 (a /me response
 * without identity_id, or a domain response without full_domain) throws a
 * protocol-violation Error instead of silently falling back — a corrupt
 * cws-core response must never be masked as "no bound domain", or a stale env
 * URL could keep receiving webhooks.
 *
 * `resolveAgentBaseUrl()` takes injectable deps (getFn / apiPathFn / env /
 * config / identityId) so callers — `CoreService.agentDomain()`, future step-3
 * channel code, and unit tests — all share one resolution path without hitting
 * the network in tests.
 *
 * Extraction notes (ported from zylos-openmax src/lib/agent-domain.js):
 *   - The old `import { get, apiPath } from './client.js'` and
 *     `import { loadConfig } from './config.js'` module-global defaults are
 *     GONE — the SDK has no config.js and reaches cws-core only through the
 *     injected `CwsHttpClient`. Pass `deps.http` (a CwsHttpClient) and getFn /
 *     apiPathFn are derived from it; or pass getFn / apiPathFn explicitly.
 *   - `config` is a pre-loaded config object (else `{}`); there is no implicit
 *     `loadConfig()` — the adapter owns config loading.
 */

/** Default cws-core API prefix, mirroring CwsHttpClient.apiPath / COCO_API_PREFIX. */
const defaultApiPath = (p) => `/api/v1${p}`;

/**
 * Derive { getFn, apiPathFn } from deps: an explicit getFn/apiPathFn wins, then
 * a CwsHttpClient (`deps.http`), else a null getFn (callers that need it throw)
 * and the default api prefix.
 */
function resolveHttpDeps(deps) {
  const http = deps.http || null;
  const getFn = deps.getFn || (http ? http.get.bind(http) : null);
  const apiPathFn = deps.apiPathFn || (http ? http.apiPath.bind(http) : defaultApiPath);
  return { getFn, apiPathFn };
}

/** Trim whitespace and strip any trailing slashes so base_url never ends in "/". */
export function normalizeBaseUrl(u) {
  return String(u ?? '').trim().replace(/\/+$/, '');
}

/**
 * Resolve this agent's identity_id. Prefers config `agent.identity_id` (the
 * canonical global identity); falls back to cws-core `GET /me` which returns
 * `{ ..., identity_id }` when config is missing it.
 *
 * @param {object}   [deps]
 * @param {object}   [deps.config]     pre-loaded config (default {})
 * @param {object}   [deps.http]       CwsHttpClient (source of getFn/apiPathFn)
 * @param {Function} [deps.getFn]      get(path) → response
 * @param {Function} [deps.apiPathFn]  apiPath(p) → prefixed path
 * @returns {Promise<string>}          identity_id (never empty)
 * @throws {Error} when /me succeeds (200) but carries no identity_id — a
 *                 cws-core protocol violation that must fail loudly rather
 *                 than silently skip the core domain tier.
 */
export async function resolveAgentIdentityId(deps = {}) {
  const { config = {} } = deps;
  const { getFn, apiPathFn } = resolveHttpDeps(deps);
  const fromCfg = config?.agent?.identity_id;
  if (fromCfg) return String(fromCfg);

  if (!getFn) {
    throw new Error('resolveAgentIdentityId requires an injected http client (deps.http) or deps.getFn');
  }
  const me = await getFn(apiPathFn('/me'));
  const id = me?.identity_id || me?.identity?.id;
  if (!id) {
    throw new Error(
      'cws-core protocol violation: GET /me succeeded but returned no identity_id',
    );
  }
  return String(id);
}

/**
 * Resolve the agent's public base URL via the two-tier order documented above.
 *
 * @param {object}   [deps]
 * @param {object}   [deps.http]       CwsHttpClient (source of getFn/apiPathFn)
 * @param {Function} [deps.getFn]      get(path) → response
 * @param {Function} [deps.apiPathFn]  apiPath(p) → prefixed path
 * @param {object}   [deps.env]        env source (else process.env)
 * @param {object}   [deps.config]     pre-loaded config (default {})
 * @param {string}   [deps.identityId] skip identity resolution when provided
 * @returns {Promise<
 *   { ok:true,  source:'core', full_domain:string, label?:string, root_suffix?:string, base_url:string } |
 *   { ok:true,  source:'env',  base_url:string } |
 *   { ok:false, error:string }
 * >}
 * @throws {Error} on non-404 core errors and on malformed 200 responses
 *                 (protocol violations) — see module doc; only a 404 reaches
 *                 the env fallback.
 */
export async function resolveAgentBaseUrl(deps = {}) {
  const { env = process.env, config = {} } = deps;
  const { getFn, apiPathFn } = resolveHttpDeps(deps);

  // Tier 1 — cws-core bound domain.
  const identityId =
    deps.identityId || (await resolveAgentIdentityId({ config, getFn, apiPathFn }));

  if (identityId) {
    try {
      const domain = await getFn(apiPathFn(`/platform-agents/${identityId}/domain`));
      const fullDomain = domain?.full_domain;
      if (!fullDomain) {
        // A 200 MUST carry full_domain — "no bound domain" is signalled by a
        // 404, never by an empty body. Fail loudly instead of silently
        // falling back to a possibly-stale env URL.
        throw new Error(
          `cws-core protocol violation: GET /platform-agents/${identityId}/domain ` +
          'succeeded but returned no full_domain',
        );
      }
      return {
        ok: true,
        source: 'core',
        full_domain: fullDomain,
        label: domain.label,
        root_suffix: domain.root_suffix,
        base_url: normalizeBaseUrl(`https://${fullDomain}`),
      };
    } catch (err) {
      // ONLY a 404 (no bound domain) falls through to the env tier. Any other
      // error (auth, 5xx, network, protocol violation) is a real failure and
      // must propagate.
      if (err?.status !== 404) throw err;
    }
  }

  // Tier 2 — AGENT_PUBLIC_BASE_URL fallback.
  const envUrl = normalizeBaseUrl(env?.AGENT_PUBLIC_BASE_URL);
  if (envUrl) {
    return { ok: true, source: 'env', base_url: envUrl };
  }

  return { ok: false, error: 'no bound domain and AGENT_PUBLIC_BASE_URL unset' };
}
