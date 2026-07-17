import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TmService, createTmService } from './tm.js';
import { makeClient, ok, clearCwsEnv } from './_fixtures.js';

clearCwsEnv();

test('projectCreate forwards atomic project fields + Bearer auth, uses default prefix', async () => {
  const { http, fetch } = makeClient([ok({ id: 'p1' })], { apiKey: 'cli-contract-token' });
  const tm = new TmService(http);
  const out = await tm.projectCreate({
    name: 'Semantic alignment',
    leadMemberId: 'lead-1',
    knowledgeBaseId: 'kb-1',
    memberIds: ['member-1', 'member-2'],
    isDefault: true,
  });
  const req = fetch.requests[0];
  assert.equal(req.method, 'POST');
  assert.equal(req.path, '/api/v1/projects');
  assert.equal(req.authorization, 'Bearer cli-contract-token');
  assert.deepEqual(req.body, {
    name: 'Semantic alignment',
    lead_member_id: 'lead-1',
    knowledge_base_id: 'kb-1',
    member_ids: ['member-1', 'member-2'],
    is_default: true,
  });
  assert.deepEqual(out, { id: 'p1' }); // D8 envelope unwrapped
});

test('projectList and issueList forward the query param', async () => {
  const c1 = makeClient([ok([])]);
  await createTmService(c1.http).projectList({ query: 'alpha' });
  assert.equal(c1.fetch.requests[0].path, '/api/v1/projects');
  assert.equal(c1.fetch.requests[0].query.query, 'alpha');

  const c2 = makeClient([ok([])]);
  await new TmService(c2.http).issueList({ query: 'beta' });
  assert.equal(c2.fetch.requests[0].path, '/api/v1/issues');
  assert.equal(c2.fetch.requests[0].query.query, 'beta');
});

test('issueCreate preserves backlog presence and requires owner + lead', async () => {
  const c1 = makeClient([ok()]);
  await new TmService(c1.http).issueCreate({
    projectId: 'project-1', title: 'Record discovered issue',
    leadAgentId: 'agent-1', ownerMemberId: 'human-1',
  });
  assert.equal(c1.fetch.requests[0].path, '/api/v1/projects/project-1/issues');
  // undefined backlog is dropped by JSON serialization (matches CLI-over-HTTP behavior).
  assert.equal(Object.hasOwn(c1.fetch.requests[0].body, 'backlog'), false);

  const c2 = makeClient([ok()]);
  await new TmService(c2.http).issueCreate({
    projectId: 'project-1', title: 'Start immediately',
    leadAgentId: 'agent-1', ownerMemberId: 'human-1', backlog: false,
  });
  assert.equal(c2.fetch.requests[0].body.backlog, false);

  const c3 = makeClient([ok()]);
  assert.throws(
    () => new TmService(c3.http).issueCreate({ projectId: 'project-1', title: 'Missing ownership' }),
    /leadAgentId, ownerMemberId/,
  );
});

test('issueAcceptDelivered defaults to the Lead text-card proxy source', async () => {
  const c1 = makeClient([ok()]);
  await new TmService(c1.http).issueAcceptDelivered({ id: 'issue-1' });
  assert.equal(c1.fetch.requests[0].method, 'POST');
  assert.equal(c1.fetch.requests[0].path, '/api/v1/issues/issue-1/accept-delivered');
  assert.deepEqual(c1.fetch.requests[0].body, { source: 'text_card_proxy' });

  const c2 = makeClient([ok()]);
  await new TmService(c2.http).issueAcceptDelivered({ id: 'issue-1', source: 'explicit' });
  assert.deepEqual(c2.fetch.requests[0].body, { source: 'explicit' });
});

test('commentList uses cursor pagination (no page/page_size)', async () => {
  const { http, fetch } = makeClient([ok([])]);
  await new TmService(http).commentList({
    workType: 'task', workId: 'task-1', cursor: 'cursor-1', limit: 25, orderBy: 'created_at desc',
  });
  const q = fetch.requests[0].searchParams;
  assert.equal(q.get('work_type'), 'task');
  assert.equal(q.get('work_id'), 'task-1');
  assert.equal(q.get('cursor'), 'cursor-1');
  assert.equal(q.get('limit'), '25');
  assert.equal(q.get('order_by'), 'created_at desc');
  assert.equal(q.has('page'), false);
  assert.equal(q.has('page_size'), false);
});

test('project member add/remove match BFF paths and bodies', async () => {
  const c1 = makeClient([ok()]);
  await new TmService(c1.http).projectMemberAdd({ id: 'project-1', memberId: 'member-1' });
  assert.equal(c1.fetch.requests[0].method, 'POST');
  assert.equal(c1.fetch.requests[0].path, '/api/v1/projects/project-1/members');
  assert.deepEqual(c1.fetch.requests[0].body, { member_id: 'member-1', role: 'member' });

  const c2 = makeClient([ok()]);
  await new TmService(c2.http).projectMemberRemove({ id: 'project-1', memberId: 'member-1' });
  assert.equal(c2.fetch.requests[0].method, 'DELETE');
  assert.equal(c2.fetch.requests[0].path, '/api/v1/projects/project-1/members/member-1');
});

test('taskCreate uses the doubly-nested path; claim/start have no body', async () => {
  const c1 = makeClient([ok()]);
  await new TmService(c1.http).taskCreate({
    projectId: 'p1', issueId: 'i1', title: 'T', dependsOn: ['t0'],
  });
  assert.equal(c1.fetch.requests[0].path, '/api/v1/projects/p1/issues/i1/tasks');
  // undefined fields are dropped by JSON serialization.
  assert.deepEqual(c1.fetch.requests[0].body, { title: 'T', description: '', depends_on: ['t0'] });

  const c2 = makeClient([ok()]);
  await new TmService(c2.http).taskClaim({ id: 't1' });
  assert.equal(c2.fetch.requests[0].method, 'POST');
  assert.equal(c2.fetch.requests[0].path, '/api/v1/tasks/t1/claim');
  assert.equal(c2.fetch.requests[0].body, undefined);
});

test('taskStatus is an alias for taskTransition (target_status)', async () => {
  const { http, fetch } = makeClient([ok()]);
  await new TmService(http).taskStatus({ id: 't1', status: 'done' });
  assert.equal(fetch.requests[0].path, '/api/v1/tasks/t1/transition');
  assert.deepEqual(fetch.requests[0].body, { target_status: 'done' });
});

test('blueprintSetSteps is a PUT-replace on the blueprint steps path', async () => {
  const { http, fetch } = makeClient([ok()]);
  await new TmService(http).blueprintSetSteps({ id: 'bp1', steps: [{ temp_id: 's1' }] });
  assert.equal(fetch.requests[0].method, 'PUT');
  assert.equal(fetch.requests[0].path, '/api/v1/blueprints/bp1/steps');
  assert.deepEqual(fetch.requests[0].body, { steps: [{ temp_id: 's1' }] });
});

test('issueSubmitPlan requires blueprintId', async () => {
  const { http } = makeClient([ok()]);
  assert.throws(() => new TmService(http).issueSubmitPlan({ id: 'i1' }), /requires blueprintId/);
});

test('eventBindingCreate nests the spec block', async () => {
  const { http, fetch } = makeClient([ok()]);
  await new TmService(http).eventBindingCreate({
    cronExpr: '0 9 * * *', leadMemberId: 'l1', ownerMemberId: 'o1',
    projectId: 'p1', title: 'Daily', description: 'd',
  });
  assert.equal(fetch.requests[0].path, '/api/v1/event-bindings');
  assert.deepEqual(fetch.requests[0].body, {
    cron_expr: '0 9 * * *', lead_member_id: 'l1', owner_member_id: 'o1',
    spec: { project_id: 'p1', title: 'Daily', description: 'd' },
  });
});

test('paginated list unwraps into { data, pagination }', async () => {
  const { http } = makeClient([{ json: { data: [{ id: 't1' }], pagination: { total: 1 }, request_id: 'r' } }]);
  const out = await new TmService(http).taskList({ page: 1, pageSize: 20 });
  assert.deepEqual(out, { data: [{ id: 't1' }], pagination: { total: 1 } });
});

test('constructor rejects a missing http client', () => {
  assert.throws(() => new TmService(), /requires a CwsHttpClient/);
});
