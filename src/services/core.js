/**
 * Core service client — read-mostly directory queries + a few write ops against
 * cws-core (contract-v5): identity, members, agents, orgs, roles, invitations,
 * onboarding.
 *
 * Ported from zylos-openmax `src/cli/core.js`. The argv/stdout CLI shell stays
 * in the adapter.
 *
 * Coupling abstracted (design §3.3 / §4.2 — `CoreService(http, cfg?, agentDomain?)`):
 *   - `selfRename` PATCHes /me always; the local per-org `self.name` mirror runs
 *     only when a `config` provider is injected (else orgs_synced is []).
 *   - `agentDomain` delegates to an injected `agentDomain` provider (a function
 *     or `{ resolve() }`) — the old `resolveAgentBaseUrl()` import lived in
 *     identity/agent-domain.js and is not part of this module.
 *   - `frontendUrl` uses the http client's frontendUrl() (no config coupling).
 *
 * Config provider interface (optional): { enabledOrgs(): OrgConfig[],
 *   updateConfig(fn): Config }.
 */

/** Normalize a scalar-or-array param into an array (drops null/undefined). */
const toArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

export class CoreService {
  /**
   * @param {import('../transport/http.js').CwsHttpClient} http
   * @param {object} [config]  config provider for selfRename's local mirror
   * @param {(function|{resolve:Function})} [agentDomain]  resolver for
   *        agentDomain(); called with no args, returns the agent-domain result
   *        object ({ ok, source, base_url, ... }).
   */
  constructor(http, config = null, agentDomain = null) {
    if (!http) throw new Error('CoreService requires a CwsHttpClient');
    this.http = http;
    this.config = config;
    this.agentDomainProvider = agentDomain;
  }

  _p(path) { return this.http.apiPath(path); }

  // ---- Identity ------------------------------------------------------------

  me() { return this.http.get(this._p('/me')); }

  /**
   * Resolve THIS agent's public base URL for webhook-channel URL building.
   * Delegates to the injected agentDomain provider. Returns the provider's
   * result object as-is (the argv shell decides exit codes from `ok`).
   */
  async agentDomain() {
    const provider = this.agentDomainProvider;
    if (!provider) throw new Error('agentDomain requires an injected agentDomain provider');
    const fn = typeof provider === 'function' ? provider : provider.resolve?.bind(provider);
    if (!fn) throw new Error('agentDomain provider must be a function or expose resolve()');
    return fn();
  }

  /**
   * Rename self (display name). PATCH /me updates identity-level display_name
   * across every org; when a config provider is present, mirror the new name
   * into each enabled org's `self.name`.
   */
  async selfRename(params = {}) {
    const raw = params.name || params.displayName || params.display_name;
    const name = typeof raw === 'string' ? raw.trim() : '';
    if (!name) {
      const err = new Error('self_rename requires a non-empty {name}');
      err.status = 400;
      throw err;
    }

    const updated = await this.http.patch(this._p('/me'), { display_name: name });

    let orgsSynced = [];
    if (this.config && typeof this.config.enabledOrgs === 'function') {
      const orgs = this.config.enabledOrgs();
      if (orgs.length && typeof this.config.updateConfig === 'function') {
        this.config.updateConfig((cfg) => {
          for (const { org_id } of orgs) {
            const org = cfg.orgs?.[org_id];
            if (!org) continue;
            org.self = { ...(org.self || {}), name };
          }
        });
      }
      orgsSynced = orgs.map((o) => o.org_id);
    }

    return {
      display_name: updated?.display_name ?? name,
      identity_id:  updated?.identity_id,
      orgs_synced:  orgsSynced,
    };
  }

  // ---- Members -------------------------------------------------------------

  memberList(params = {}) {
    return this.http.get(this._p('/members'), {
      kind:      params.kind || params.type,
      status:    params.status,
      search:    params.search || params.q,
      page:      params.page,
      page_size: params.pageSize ?? params.limit,
      order_by:  params.orderBy,
    });
  }

  memberGet(params = {}) { return this.http.get(this._p(`/members/${params.memberId}`)); }

  projectMembers(params = {}) {
    return this.http.get(this._p(`/projects/${params.projectId}/members`));
  }

  agentProfiles(params = {}) {
    return this.http.get(this._p('/agent-profiles'), {
      project_id: params.projectId || params.project_id,
      member_id:  toArray(params.memberIds ?? params.memberId ?? params.member_id),
      include:    params.capabilities
        ? Array.from(new Set([...toArray(params.include), 'capabilities']))
        : toArray(params.include),
    });
  }

  // ---- Platform agents (lifecycle) -----------------------------------------

  platformAgentCreate(params = {}) {
    return this.http.post(this._p('/platform-agents'), {
      display_name: params.displayName || params.name,
      description:  params.description,
      metadata:     params.metadata,
    });
  }

  platformAgentDelete(params = {}) {
    return this.http.del(this._p(`/platform-agents/${params.memberId}`));
  }

  // ---- Onboarding ----------------------------------------------------------

  onboardingSession() { return this.http.get(this._p('/onboarding/session')); }

  onboardingEvent(params = {}) {
    return this.http.post(this._p('/onboarding/events'), {
      event_type:  params.eventType || params.event_type,
      occurred_at: params.occurredAt || params.occurred_at,
      meta:        params.meta,
    });
  }

  // ---- Projects (directory view) -------------------------------------------

  projectList(params = {}) {
    return this.http.get(this._p('/projects'), {
      status:    params.status ?? 'active',
      page:      params.page,
      page_size: params.pageSize ?? params.limit,
      order_by:  params.orderBy,
    });
  }

  // ---- Organizations -------------------------------------------------------

  orgList(params = {}) {
    return this.http.get(this._p('/organizations'), { order_by: params.orderBy });
  }

  orgGet(params = {}) { return this.http.get(this._p(`/organizations/${params.orgId}`)); }

  orgCreate(params = {}) {
    return this.http.post(this._p('/organizations'), {
      name:         params.name,
      slug:         params.slug,
      display_name: params.displayName || params.display_name,
    });
  }

  // Server requires a body to be present; empty {} is fine (schema is closed).
  orgSwitch(params = {}) {
    return this.http.post(this._p(`/organizations/${params.orgId}/switch`), {});
  }

  // ---- Roles ---------------------------------------------------------------

  roleList(params = {}) { return this.http.get(this._p('/roles'), { scope: params.scope }); }

  // ---- Invitations ---------------------------------------------------------

  invitationCreate(params = {}) {
    return this.http.post(this._p('/invitations'), {
      email:        params.email,
      display_name: params.displayName ?? params.display_name,
      role_id:      params.roleId,
      message:      params.message,
    });
  }

  invitationList(params = {}) {
    return this.http.get(this._p('/invitations'), {
      status:    params.status,
      page:      params.page,
      page_size: params.pageSize ?? params.limit,
      order_by:  params.orderBy,
    });
  }

  invitationAccept(params = {}) {
    return this.http.post(this._p(`/invitations/${params.invitationId}/accept`), {
      token: params.token,
    });
  }

  invitationRevoke(params = {}) {
    return this.http.del(this._p(`/invitations/${params.invitationId}`));
  }

  // ---- Helpers -------------------------------------------------------------

  // Local helper — build a browser-navigable frontend URL. Not an API call.
  frontendUrl(params = {}) {
    const p = params.path || params.p || '';
    if (!p) throw Object.assign(new Error('path is required'), { status: 400 });
    return { url: this.http.frontendUrl(p) };
  }
}

export function createCoreService(http, config, agentDomain) {
  return new CoreService(http, config, agentDomain);
}
