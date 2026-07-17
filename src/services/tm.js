/**
 * Task Management service client — cws-core@contract-v2 task/project/issue
 * surface (cws-core proxies all TM RPCs to cws-work).
 *
 * Ported verbatim (request shapes / paths / defaults / validation) from
 * zylos-openmax `src/cli/tm.js`. The argv-parsing + stdout/stderr CLI shell
 * (`main()`) stays in the runtime adapter — this module is the programmatic
 * client surface only.
 *
 * Every method takes a single `params` object (the same JSON the CLI accepted)
 * and returns the parsed/unwrapped response from the injected `CwsHttpClient`
 * (D8 envelope already stripped by the http client).
 *
 * Method names are the CLI command strings camelCased (dots/hyphens collapse):
 *   project.list        → projectList()
 *   issue.create        → issueCreate()
 *   event-binding.create → eventBindingCreate()
 *
 * Pagination convention (unchanged from the CLI):
 *   - user-facing camelCase: page, pageSize, orderBy
 *   - wire snake_case:       page, page_size, order_by
 *   - most list endpoints use offset paging {page, page_size}; comment.list
 *     follows its backend contract and uses {cursor, limit}.
 *
 * No coupling to config / ~/zylos / env: the HTTP base URL, auth, and org
 * routing all live in the injected CwsHttpClient.
 */

// Build the standard PageParams query block from user-supplied camelCase.
function pageParams(p) {
  return {
    page:      p.page,
    page_size: p.pageSize,
    order_by:  p.orderBy,
  };
}

function cursorParams(p) {
  return {
    cursor:   p.cursor,
    limit:    p.limit,
    order_by: p.orderBy,
  };
}

function issueListParams(p) {
  return {
    status:           p.status,
    statuses:         p.statuses,
    priority:         p.priority,
    include_archived: p.includeArchived,
    query:            p.query,
    ...pageParams(p),
  };
}

function requireParams(commandName, params, names) {
  const missing = names.filter((name) => params[name] == null || params[name] === '');
  if (missing.length > 0) {
    throw new Error(`${commandName} requires ${missing.join(', ')}`);
  }
}

export class TmService {
  /** @param {import('../transport/http.js').CwsHttpClient} http */
  constructor(http) {
    if (!http) throw new Error('TmService requires a CwsHttpClient');
    this.http = http;
  }

  _p(path) { return this.http.apiPath(path); }

  // ===========================================================================
  //  PROJECT
  // ===========================================================================

  projectList(params = {}) {
    return this.http.get(this._p('/projects'), {
      status: params.status,       // enum: active|archived
      query:  params.query,
      ...pageParams(params),
    });
  }

  // contract-v2 create-project body: { name*, description?, slug?, is_default,
  // lead_member_id*, knowledge_base_id?, member_ids? }
  projectCreate(params = {}) {
    return this.http.post(this._p('/projects'), {
      name:              params.name,
      description:       params.description,
      slug:              params.slug,
      is_default:        params.isDefault,
      lead_member_id:    params.leadMemberId,
      knowledge_base_id: params.knowledgeBaseId,
      member_ids:        params.memberIds,
    });
  }

  projectGet(params = {}) { return this.http.get(this._p(`/projects/${params.id}`)); }

  // contract-v2 update-project body: { name?, description?, lead_member_id? }
  projectUpdate(params = {}) {
    return this.http.patch(this._p(`/projects/${params.id}`), {
      name:           params.name,
      description:    params.description,
      lead_member_id: params.leadMemberId,
    });
  }

  projectArchive(params = {}) { return this.http.post(this._p(`/projects/${params.id}/archive`)); }

  projectMembers(params = {}) {
    return this.http.get(this._p(`/projects/${params.id}/members`), pageParams(params));
  }

  projectMemberAdd(params = {}) {
    return this.http.post(this._p(`/projects/${params.id}/members`), {
      member_id: params.memberId,
      role:      params.role ?? 'member',
    });
  }

  projectMemberRemove(params = {}) {
    return this.http.del(this._p(`/projects/${params.id}/members/${params.memberId}`));
  }

  // ===========================================================================
  //  ISSUE  (write paths use the FLAT /issues/{id}, not /projects/{pid}/issues/{id})
  // ===========================================================================

  issueList(params = {}) { return this.http.get(this._p('/issues'), issueListParams(params)); }

  issueListInProject(params = {}) {
    return this.http.get(this._p(`/projects/${params.projectId}/issues`), issueListParams(params));
  }

  issueGet(params = {}) { return this.http.get(this._p(`/issues/${params.id}`)); }

  issueCreate(params = {}) {
    requireParams('issue.create', params, ['projectId', 'title', 'leadAgentId', 'ownerMemberId']);
    return this.http.post(this._p(`/projects/${params.projectId}/issues`), {
      title:                  params.title,
      description:            params.description || '',
      backlog:                params.backlog,
      priority:               params.priority,   // low|medium|high (optional, default medium)
      lead_agent_id:          params.leadAgentId,
      owner_member_id:        params.ownerMemberId,
      origin_conversation_id: params.originConversationId,
      origin_message_id:      params.originMessageId,
    });
  }

  issueUpdate(params = {}) {
    return this.http.patch(this._p(`/issues/${params.id}`), {
      title:       params.title,
      description: params.description,
      priority:    params.priority,
    });
  }

  issueActivate(params = {}) {
    return this.http.post(this._p(`/issues/${params.id}/activate`), {
      source: params.source ?? 'lead_chat',
    });
  }

  issueSubmitPlan(params = {}) {
    if (!params.blueprintId) {
      throw new Error('issue.submit_plan requires blueprintId; create a one-step Blueprint for simple tasks');
    }
    return this.http.post(this._p(`/issues/${params.id}/submit-plan`), {
      plan_text:       params.planText ?? params.plan,
      blueprint_id:    params.blueprintId,
      source:          params.source ?? 'lead_chat',
      card_message_id: params.cardMessageId,
    });
  }

  issueAcceptPlan(params = {}) {
    return this.http.post(this._p(`/issues/${params.id}/accept-plan`), {
      source: params.source ?? 'text_card_proxy',
    });
  }

  issueDeliver(params = {}) { return this.http.post(this._p(`/issues/${params.id}/deliver`)); }

  issueResume(params = {}) {
    return this.http.post(this._p(`/issues/${params.id}/resume`), {
      reason: params.reason ?? params.feedback,
      source: params.source ?? 'lead_chat',
    });
  }

  issueAcceptDelivered(params = {}) {
    return this.http.post(this._p(`/issues/${params.id}/accept-delivered`), {
      source: params.source ?? 'text_card_proxy',
    });
  }

  issueReassignOwner(params = {}) {
    return this.http.post(this._p(`/issues/${params.id}/reassign-owner`), {
      new_owner_member_id: params.ownerMemberId ?? params.newOwnerMemberId,
    });
  }

  issueMoveProject(params = {}) {
    return this.http.post(this._p(`/issues/${params.id}/move`), {
      new_project_id: params.targetProjectId ?? params.newProjectId,
    });
  }

  issueTerminate(params = {}) {
    return this.http.post(this._p(`/issues/${params.id}/terminate`), {
      reason: params.reason,
      source: params.source ?? 'lead_chat',
    });
  }

  // ===========================================================================
  //  TASK  (create uses the doubly-nested /projects/{pid}/issues/{iid}/tasks;
  //  v0.7 claim/start split: claim only assigns, start begins work + attempt)
  // ===========================================================================

  taskList(params = {}) {
    return this.http.get(this._p('/tasks'), {
      project_id:       params.projectId,
      issue_id:         params.issueId,
      status:           params.status,   // pending|assigned|running|done|failed|cancelled
      include_archived: params.includeArchived,
      ...pageParams(params),
    });
  }

  taskGet(params = {}) { return this.http.get(this._p(`/tasks/${params.id}`)); }

  taskCreate(params = {}) {
    return this.http.post(
      this._p(`/projects/${params.projectId}/issues/${params.issueId}/tasks`),
      {
        title:             params.title,
        description:       params.description || '',
        assignee_id:       params.assigneeId,
        blueprint_step_id: params.blueprintStepId,
        depends_on:        params.dependsOn,
      },
    );
  }

  taskClaim(params = {}) { return this.http.post(this._p(`/tasks/${params.id}/claim`)); }

  taskStart(params = {}) { return this.http.post(this._p(`/tasks/${params.id}/start`)); }

  taskTransition(params = {}) {
    return this.http.post(this._p(`/tasks/${params.id}/transition`), {
      target_status: params.status ?? params.targetStatus,
    });
  }

  // Backward-compat alias for older scripts (task.status).
  taskStatus(params = {}) { return this.taskTransition(params); }

  taskReassign(params = {}) {
    return this.http.post(this._p(`/tasks/${params.id}/reassign`), {
      new_assignee_id: params.assigneeId ?? params.newAssigneeId,
    });
  }

  // ===========================================================================
  //  COMMENT
  // ===========================================================================

  commentCreate(params = {}) {
    return this.http.post(this._p('/comments'), {
      work_type:     params.workType,
      work_id:       params.workId,
      body_markdown: params.bodyMarkdown ?? params.body,
    });
  }

  commentGet(params = {}) { return this.http.get(this._p(`/comments/${params.id}`)); }

  commentList(params = {}) {
    return this.http.get(this._p('/comments'), {
      work_type: params.workType,
      work_id:   params.workId,
      ...cursorParams(params),
    });
  }

  // ===========================================================================
  //  BLUEPRINT  (set_steps is PUT-and-replace, not POST-and-append)
  // ===========================================================================

  blueprintCreate(params = {}) {
    return this.http.post(this._p(`/issues/${params.issueId}/blueprints`), {
      steps:            params.steps,
      estimated_budget: params.estimatedBudget,
      notes:            params.notes,
    });
  }

  blueprintGet(params = {}) {
    return this.http.get(this._p(`/blueprints/${params.id}`), {
      include_steps: params.includeSteps,
    });
  }

  blueprintList(params = {}) {
    return this.http.get(this._p(`/issues/${params.issueId}/blueprints`), pageParams(params));
  }

  blueprintSetSteps(params = {}) {
    return this.http.put(this._p(`/blueprints/${params.blueprintId ?? params.id}/steps`), {
      steps: params.steps,
    });
  }

  // ===========================================================================
  //  ATTEMPT
  // ===========================================================================

  attemptCreate(params = {}) { return this.http.post(this._p(`/tasks/${params.taskId}/attempts`)); }

  attemptGet(params = {}) { return this.http.get(this._p(`/attempts/${params.id}`)); }

  attemptList(params = {}) {
    return this.http.get(this._p(`/tasks/${params.taskId}/attempts`), pageParams(params));
  }

  attemptTransition(params = {}) {
    return this.http.post(this._p(`/attempts/${params.id}/transition`), {
      target_status:                   params.status ?? params.targetStatus,
      failure_reason:                  params.failureReason,
      blocked_on_approval_request_ids: params.blockedOnApprovalRequestIds,
    });
  }

  // ===========================================================================
  //  EVENT BINDING  (定时任务 / create-by-agent)
  // ===========================================================================

  eventBindingCreate(params = {}) {
    return this.http.post(this._p('/event-bindings'), {
      cron_expr:       params.cronExpr,
      lead_member_id:  params.leadMemberId,
      owner_member_id: params.ownerMemberId,
      spec: {
        project_id:  params.projectId,
        title:       params.title,
        description: params.description,
      },
    });
  }

  eventBindingList()       { return this.http.get(this._p('/event-bindings')); }
  eventBindingGet(params = {})    { return this.http.get(this._p(`/event-bindings/${params.id}`)); }
  eventBindingDelete(params = {}) { return this.http.del(this._p(`/event-bindings/${params.id}`)); }
}

export function createTmService(http) {
  return new TmService(http);
}
