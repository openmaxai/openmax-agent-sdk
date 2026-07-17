/**
 * Shared HTTP client for all CWS REST calls (native fetch + auth headers).
 *
 * The agent only talks to ONE REST surface: cws-core (the BFF). cws-core acts
 * as the gateway for cws-kb and cws-as — KB/AS routes are forwarded server-side,
 * not called directly.
 *
 *   - cws-core gateway → /me, /members, /agents, /projects, /tasks, /issues,
 *                        /conversations, /conversations/{id}/messages,
 *                        /api/v1/kbs/*, /api/v1/orgs/{orgId}/*,
 *                        /api/v1/artifacts/*
 *                        base URL  : bff url
 *                        scope hdr : X-Org-Id (for kb/as paths)
 *
 * Multi-org JWT routing
 * ---------------------
 * Every request resolves its bearer token via the injected token manager's
 * `getAccessToken(orgId)`. When the caller threads an `orgId` (kbClient/asClient
 * factories, per-org REST helpers getForOrg/postForOrg/...), that org's cached
 * JWT is used. When `orgId` is omitted, we fall back to `resolveDefaultOrgId()`.
 *
 * Cloudflare Access (test env only): every request is also tagged with the
 * CF-Access-Client-Id / CF-Access-Client-Secret headers from cf-access.js.
 *
 * On success: returns parsed JSON (or raw text if response is not JSON), with
 * the cws-core D8 envelope unwrapped.
 * On HTTP error: throws Error whose .message is the server's error detail
 * and .status carries the HTTP status code.
 *
 * Extraction notes (ported from zylos-openmax src/lib/client.js):
 *   - The module-global functions became a `CwsHttpClient` class.
 *   - `loadConfig()` coupling (bff_url / api_key / device_id / client_version /
 *     default org / frontend_base_path) is replaced by constructor options + env.
 *   - JWT resolution + 401 invalidate delegate to an injected `tokenManager`
 *     ({ getAccessToken, invalidate }); no direct import of token.js.
 *   - Logging routes through an injected `logger` (defaults to console).
 *   - `fetch` is injectable for testing (defaults to global fetch).
 *   - RPC logging (COCO_RPC_LOG / COCO_RPC_LOG_FILE) and the 401 refresh-retry
 *     throttle, D8 unwrap, and error-envelope extraction are preserved.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { cfAccessHeaders } from './cf-access.js';

// 401 → refresh-and-retry throttle window. Keyed by effective orgId. Records
// the timestamp of the last 401-triggered refresh; subsequent 401s within the
// window propagate without re-refreshing — protects /auth/refresh from being
// storm-called during a server-side outage or a request that always 401s.
const REFRESH_ON_401_WINDOW_MS = 10 * 60 * 1000;   // 10 minutes

// ── RPC logging (module-level, env-gated) ────────────────────────────────────
// Two independent sinks: stdout (COCO_RPC_LOG, default ON, '0' silences) and a
// file (COCO_RPC_LOG_FILE, independent of stdout). Tagged `[rpc]`.
function rpcLogStdoutEnabled() {
  return process.env.COCO_RPC_LOG !== '0';
}
function rpcLogFilePath() {
  const p = process.env.COCO_RPC_LOG_FILE;
  return p && p.length > 0 ? p : null;
}
let _rpcLogFileEnsured = false;
function ensureRpcLogDir(filePath) {
  if (_rpcLogFileEnsured) return;
  try { mkdirSync(dirname(filePath), { recursive: true }); } catch {}
  _rpcLogFileEnsured = true;
}
function appendRpcLine(line) {
  const filePath = rpcLogFilePath();
  if (!filePath) return;
  try {
    ensureRpcLogDir(filePath);
    appendFileSync(filePath, `${new Date().toISOString()} ${line}\n`);
  } catch { /* best-effort: don't crash RPCs on disk errors */ }
}

// ── URL building ─────────────────────────────────────────────────────────────
function buildUrl(baseUrl, path, query) {
  const base = (baseUrl || '').replace(/\/$/, '');
  let url = path.startsWith('http') ? path : `${base}${path}`;
  if (!query) return url;

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      for (const v of value) params.append(key, String(v));
    } else {
      params.set(key, String(value));
    }
  }
  const qs = params.toString();
  if (qs) url += `?${qs}`;
  return url;
}

export class CwsHttpClient {
  /**
   * @param {Object} [opts]
   * @param {string} [opts.baseUrl]             bff base URL (else COCO_API_URL env, else localhost)
   * @param {string} [opts.apiKey]              offline fallback api_key (cfg.agent.api_key equivalent)
   * @param {string} [opts.deviceId]            X-Device-Id (else COCO_DEVICE_ID env)
   * @param {string} [opts.clientVersion]       X-Client-Version (else COCO_CLIENT_VERSION env)
   * @param {Object} [opts.cfAccess]            cf_access config for CF-Access headers
   * @param {{getAccessToken:(orgId?:string)=>Promise<string>, invalidate:(orgId?:string)=>void}} [opts.tokenManager]
   * @param {() => string} [opts.resolveDefaultOrgId]  default org (else COCO_ORG_ID env)
   * @param {string} [opts.frontendBasePath]    frontend SPA mount (default /workspace)
   * @param {string} [opts.apiPrefix]           apiPath() prefix (else COCO_API_PREFIX ?? /api/v1)
   * @param {{log:Function,warn:Function,error:Function}} [opts.logger]  default console
   * @param {typeof fetch} [opts.fetch]         fetch impl (default global fetch)
   */
  constructor({
    baseUrl,
    apiKey,
    deviceId,
    clientVersion,
    cfAccess,
    tokenManager,
    resolveDefaultOrgId,
    frontendBasePath = '/workspace',
    apiPrefix,
    logger,
    fetch: fetchImpl,
  } = {}) {
    this._baseUrl = baseUrl || null;
    this._fallbackApiKey = apiKey || null;   // offline fallback (cfg.agent.api_key)
    this._apiKeyOverride = null;             // activeApiKey — explicit override via setApiKey
    this._deviceId = deviceId || '';
    this._clientVersion = clientVersion || '';
    this._cfAccess = cfAccess;
    this._tokenManager = tokenManager || null;
    this._resolveDefaultOrgId = resolveDefaultOrgId || (() => process.env.COCO_ORG_ID || '');
    this._frontendBasePath = frontendBasePath;
    this._apiPrefix = apiPrefix;
    this._logger = logger || console;
    this._fetch = fetchImpl || ((...a) => fetch(...a));
    this._headersOverride = null;
    this._last401RefreshByOrg = new Map();
  }

  // Explicit auth/base overrides (tests / one-shot invocations). setApiKey sets
  // the activeApiKey override which short-circuits the token manager.
  setApiKey(token)  { this._apiKeyOverride = token || null; }
  setBaseUrl(url)   { this._baseUrl = url || null; }
  setHeaders(h)     { this._headersOverride = h || null; }

  // Back-compat alias — older callers expected setSessionToken; deprecated.
  setSessionToken(token) { this.setApiKey(token); }

  // ── base URL / token / header resolution ──────────────────────────────────
  _resolveBaseUrl() {
    if (this._baseUrl) return this._baseUrl;
    if (process.env.COCO_API_URL) return process.env.COCO_API_URL;
    return 'http://127.0.0.1:8080';
  }

  async _resolveToken(orgId) {
    // Prefer an explicitly-set override (tests / one-shot invocations).
    if (this._apiKeyOverride) return this._apiKeyOverride;
    // Env-supplied bearer overrides the cached agent JWT — "act as user" ops.
    if (process.env.COCO_USER_TOKEN) return process.env.COCO_USER_TOKEN;
    // Historical CLI/smoke-test name; keep as a compatibility fallback.
    if (process.env.COCO_AUTH_TOKEN) return process.env.COCO_AUTH_TOKEN;
    // Token manager: cached or freshly-refreshed JWT for the org. Falls back to
    // the raw api_key if the token manager is absent or cannot reach cws-core.
    try {
      if (!this._tokenManager) throw new Error('no token manager');
      return await this._tokenManager.getAccessToken(orgId || this._resolveDefaultOrgId());
    } catch {
      return this._fallbackApiKey || '';
    }
  }

  _resolveCoreHeaders() {
    if (this._headersOverride) return this._headersOverride;
    const out = {};
    const deviceId = this._deviceId || process.env.COCO_DEVICE_ID || '';
    const version  = this._clientVersion || process.env.COCO_CLIENT_VERSION || '';
    if (deviceId) out['X-Device-Id']      = deviceId;
    if (version)  out['X-Client-Version'] = version;
    return out;
  }

  // ── RPC log emission (uses injected logger + file sink) ─────────────────────
  _logRpcRequest(method, url, body, orgId) {
    const tag = orgId ? `org=${orgId}` : '';
    const bodyStr = body === undefined ? '(no body)' : JSON.stringify(body);
    const line = `[rpc] → ${method} ${url} ${tag} req: ${bodyStr}`;
    if (rpcLogStdoutEnabled()) this._logger.log(line);
    appendRpcLine(line);
  }

  _logRpcResponse(method, url, status, data) {
    let bodyStr;
    try { bodyStr = typeof data === 'string' ? data : JSON.stringify(data); }
    catch { bodyStr = String(data); }
    const line = `[rpc] ← ${method} ${url} resp ${status}: ${bodyStr}`;
    if (rpcLogStdoutEnabled()) {
      const level = status >= 400 ? 'warn' : 'log';
      this._logger[level](line);
    }
    appendRpcLine(line);
  }

  // ── generic request impl (baseUrl + headers injected by caller) ─────────────
  async _doRequest(baseUrl, method, path, { body, query, extraHeaders, orgId } = {}) {
    const url = buildUrl(baseUrl, path, query);

    const sendOnce = async () => {
      const headers = {
        Accept: 'application/json',
        ...cfAccessHeaders(this._cfAccess),
        ...(extraHeaders || {}),
      };
      const token = await this._resolveToken(orgId);
      if (token) headers.Authorization = `Bearer ${token}`;
      if (body !== undefined) headers['Content-Type'] = 'application/json';

      this._logRpcRequest(method, url, body, orgId);

      const res = await this._fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });

      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch { data = text; }

      this._logRpcResponse(method, url, res.status, data);
      return { res, data, text };
    };

    let attempt = await sendOnce();

    // 401 → refresh JWT and retry once. Throttle to one refresh per orgId per
    // window so an outage or misconfigured request can't storm /auth/refresh.
    if (attempt.res.status === 401) {
      const effectiveOrgId = orgId || this._resolveDefaultOrgId() || '';
      if (this._tryConsumeRefreshAttempt(effectiveOrgId)) {
        this._logger.warn(
          `[rpc] 401 on ${method} ${url}; refreshing JWT for org=${effectiveOrgId || '(identity)'} and retrying once`,
        );
        this._tokenManager?.invalidate(effectiveOrgId);
        attempt = await sendOnce();
      } else {
        this._logger.warn(
          `[rpc] 401 on ${method} ${url}; refresh throttled (last attempt <10min ago), propagating`,
        );
      }
    }

    const { res, data, text } = attempt;
    if (!res.ok) {
      // cws-core error envelope nests human-readable detail under `error`:
      //   { error: { title, status, detail, code, errors: [...] }, request_id, ... }
      let message;
      if (data && typeof data === 'object') {
        const env = (data.error && typeof data.error === 'object') ? data.error : null;
        message = (env && (env.detail || env.title))
               || data.detail
               || data.message
               || (typeof data.error === 'string' ? data.error : null);
      }
      if (!message) message = text || `HTTP ${res.status}`;
      const err = new Error(String(message));
      err.status = res.status;
      err.body = data;
      throw err;
    }
    return data;
  }

  _tryConsumeRefreshAttempt(effectiveOrgId) {
    const key = String(effectiveOrgId || '');
    const now = Date.now();
    const last = this._last401RefreshByOrg.get(key) || 0;
    if (now - last < REFRESH_ON_401_WINDOW_MS) return false;
    this._last401RefreshByOrg.set(key, now);
    return true;
  }

  // ── cws-core client (D8 envelope unwrap) ────────────────────────────────────
  async _request(method, path, opts = {}) {
    const result = await this._doRequest(this._resolveBaseUrl(), method, path, {
      ...opts,
      extraHeaders: { ...this._resolveCoreHeaders(), ...(opts.extraHeaders || {}) },
    });
    // cws-core wraps every response in a D8 envelope:
    //   - single:     { data, request_id, server_time }
    //   - paginated:  { data, pagination, request_id, server_time }
    if (result && typeof result === 'object' && 'data' in result && 'request_id' in result) {
      if ('pagination' in result) {
        return { data: result.data, pagination: result.pagination };
      }
      return result.data;
    }
    return result;
  }

  // Default-org variants (use COCO_ORG_ID env or resolveDefaultOrgId).
  get(path, query)    { return this._request('GET',    path, { query }); }
  post(path, body)    { return this._request('POST',   path, { body }); }
  patch(path, body)   { return this._request('PATCH',  path, { body }); }
  put(path, body)     { return this._request('PUT',    path, { body }); }
  del(path)           { return this._request('DELETE', path); }

  // Org-aware variants — resolve the JWT against that specific org's cache.
  getForOrg(orgId, path, query)   { return this._request('GET',    path, { query, orgId }); }
  postForOrg(orgId, path, body)   { return this._request('POST',   path, { body,  orgId }); }
  // Org-scoped GET that also attaches caller-supplied request headers (e.g.
  // cws-connect's X-Channel-Bind-Token). Same JWT resolution + D8 unwrap.
  getForOrgWithHeaders(orgId, path, extraHeaders, query) {
    return this._request('GET', path, { query, orgId, extraHeaders });
  }
  patchForOrg(orgId, path, body)  { return this._request('PATCH',  path, { body,  orgId }); }
  putForOrg(orgId, path, body)    { return this._request('PUT',    path, { body,  orgId }); }
  delForOrg(orgId, path)          { return this._request('DELETE', path, { orgId }); }

  /**
   * Prefix a logical path with the cws-core API prefix.
   * Override via constructor `apiPrefix` or COCO_API_PREFIX.
   */
  apiPath(p) {
    const prefix = this._apiPrefix ?? process.env.COCO_API_PREFIX ?? '/api/v1';
    return prefix + p;
  }

  /**
   * Build a browser-navigable frontend URL. The frontend SPA is mounted at
   * `frontendBasePath` (default /workspace) on the same origin as the bff URL.
   */
  frontendUrl(path) {
    const base = this._resolveBaseUrl().replace(/\/$/, '');
    const prefix = (this._frontendBasePath || '/workspace').replace(/\/$/, '');
    const p = (path && !path.startsWith('/')) ? `/${path}` : (path || '');
    return `${base}${prefix}${p}`;
  }

  // ── org-scoped clients for KB and AS routes ─────────────────────────────────
  _makeClient(baseUrl, scopeHeaders, orgId) {
    const wrap = (method) => (path, second) => {
      const opts = method === 'GET' ? { query: second } : { body: second };
      return this._doRequest(baseUrl, method, path, { ...opts, extraHeaders: scopeHeaders, orgId });
    };
    return {
      get:    wrap('GET'),
      post:   wrap('POST'),
      patch:  wrap('PATCH'),
      put:    wrap('PUT'),
      del:    (path) => this._doRequest(baseUrl, 'DELETE', path, { extraHeaders: scopeHeaders, orgId }),
      baseUrl,
      headers: scopeHeaders,
      orgId,
    };
  }

  /** Org-scoped client for cws-kb routes (forwarded by cws-core gateway). */
  kbClient(orgId) {
    const oid = orgId || this._resolveDefaultOrgId();
    const headers = oid ? { 'X-Org-Id': oid } : {};
    return this._makeClient(this._resolveBaseUrl(), headers, oid);
  }

  /** Org-scoped client for cws-as routes (forwarded by cws-core gateway). */
  asClient(orgId) {
    const oid = orgId || this._resolveDefaultOrgId();
    const headers = oid ? { 'X-Org-Id': oid } : {};
    return this._makeClient(this._resolveBaseUrl(), headers, oid);
  }

  // ── raw helpers (used by upload flows that need direct fetch) ────────────────

  /**
   * PUT raw bytes to an absolute (typically pre-signed) URL. Pre-signed URLs
   * carry their own auth in the query string, so no Bearer token is added, but
   * CF-Access headers are injected (the BFF gateway fronts both the API and
   * artifact storage through the same Cloudflare Access zone).
   */
  async putBytes(url, buf, contentType, extraHeaders = {}) {
    const headers = {
      'Content-Type': contentType || 'application/octet-stream',
      ...cfAccessHeaders(this._cfAccess),
      ...extraHeaders,
    };
    const res = await this._fetch(url, { method: 'PUT', headers, body: buf });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`PUT ${res.status}: ${text || res.statusText}`);
      err.status = res.status;
      throw err;
    }
    return { ok: true, status: res.status };
  }

  /**
   * GET raw bytes from an absolute URL. Used to follow pre-signed download URLs
   * returned by cws-as. Mirrors putBytes re: CF Access injection.
   */
  async getBytes(url) {
    const res = await this._fetch(url, { headers: cfAccessHeaders(this._cfAccess) });
    if (!res.ok) throw new Error(`GET ${res.status}: ${res.statusText}`);
    return Buffer.from(await res.arrayBuffer());
  }
}
