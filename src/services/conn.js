/**
 * Connection service client — cws-connect operations via the cws-core BFF.
 *
 * Ported from zylos-openmax `src/cli/conn.js`. All REST calls go through the
 * same cws-core base URL as the other services (the BFF fronts cws-connect at
 * `/connect/...` under the API prefix) — so no separate base-url handling is
 * needed; it flows through the injected CwsHttpClient like everything else.
 *
 * Coupling abstracted (design §3.3 / §4.2 — `ConnService(http, storage)`):
 *   - The agent's own member_id was resolved from config
 *     (loadConfig + resolveDefaultOrgId). That is replaced by an optional
 *     injected `resolveSelfMemberId()` (function). Callers can always override
 *     per-call via params.agentMemberId.
 *   - The local credential cache (formerly fs reads under
 *     `~/zylos/.../credentials`) is replaced by an injected `storage` provider.
 *     Without it, cached/clearCache degrade gracefully to empty results.
 *
 * Storage provider interface (optional):
 *   {
 *     listCredentials(): Array<{ connectionId: string, data: object|null }>,
 *     clearCredentials(connId?): string[],   // returns cleared connection ids
 *   }
 */

export class ConnService {
  /**
   * @param {import('../transport/http.js').CwsHttpClient} http
   * @param {object} [storage]  credential-cache provider (see interface above)
   * @param {() => string} [resolveSelfMemberId]  resolver for the agent's own
   *        member_id when params.agentMemberId is not supplied
   */
  constructor(http, storage = null, resolveSelfMemberId = null) {
    if (!http) throw new Error('ConnService requires a CwsHttpClient');
    this.http = http;
    this.storage = storage;
    this._resolveSelfMemberId = resolveSelfMemberId;
  }

  _p(path) { return this.http.apiPath(path); }

  _agentId(params) {
    const explicit = params.agentMemberId || params.agent_member_id;
    if (explicit) return explicit;
    if (typeof this._resolveSelfMemberId === 'function') {
      return this._resolveSelfMemberId() || '';
    }
    return '';
  }

  // List connections available to this agent (defaults to self).
  list(params = {}) {
    const agentId = this._agentId(params);
    if (!agentId) throw Object.assign(new Error('cannot resolve agent member_id'), { status: 400 });
    return this.http.get(this._p(`/connect/agents/${agentId}/connections`));
  }

  // Acquire credential for a connection.
  // Returns credential_mode + access_token (direct) or proxy_ref (proxy).
  acquire(params = {}) {
    const connId = params.connectionId || params.connection_id;
    if (!connId) throw Object.assign(new Error('connectionId is required'), { status: 400 });
    const agentId = this._agentId(params);
    if (!agentId) throw Object.assign(new Error('cannot resolve agent member_id'), { status: 400 });
    return this.http.post(
      this._p(`/connect/connections/${connId}/credential?agent_member_id=${encodeURIComponent(agentId)}`),
    );
  }

  // Proxy a request through a connection (proxy mode).
  proxy(params = {}) {
    const connId = params.connectionId || params.connection_id;
    if (!connId) throw Object.assign(new Error('connectionId is required'), { status: 400 });
    const agentId = this._agentId(params);
    return this.http.post(this._p(`/connect/connections/${connId}/proxy`), {
      agent_member_id: agentId,
      method:  params.method || 'GET',
      url:     params.url,
      headers: params.headers,
      body:    params.body,
    });
  }

  // Get connection details (status, owner, scopes, etc.).
  status(params = {}) {
    const connId = params.connectionId || params.connection_id;
    if (!connId) throw Object.assign(new Error('connectionId is required'), { status: 400 });
    return this.http.get(this._p(`/connect/connections/${connId}`));
  }

  // List locally cached credentials (via storage provider; empty if none).
  cached() {
    if (!this.storage || typeof this.storage.listCredentials !== 'function') {
      return { count: 0, credentials: [] };
    }
    let records;
    try {
      records = this.storage.listCredentials() || [];
    } catch {
      return { count: 0, credentials: [] };
    }
    const entries = records.map(({ connectionId, data }) => {
      if (!data) return { connection_id: connectionId, error: 'parse_failed' };
      return {
        connection_id:    connectionId,
        credential_mode:  data.credential_mode || '?',
        has_access_token: !!data.access_token,
        has_proxy_ref:    !!data.proxy_ref,
      };
    });
    return { count: entries.length, credentials: entries };
  }

  // Clear cached credentials (all, or a specific connection).
  clearCache(params = {}) {
    if (!this.storage || typeof this.storage.clearCredentials !== 'function') {
      return { cleared: [] };
    }
    const connId = params.connectionId || params.connection_id;
    try {
      const cleared = this.storage.clearCredentials(connId) || [];
      return { cleared };
    } catch {
      return { cleared: [] };
    }
  }
}

export function createConnService(http, storage, resolveSelfMemberId) {
  return new ConnService(http, storage, resolveSelfMemberId);
}
