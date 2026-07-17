import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CoreService, createCoreService } from './core.js';
import { makeClient, ok, clearCwsEnv } from './_fixtures.js';

clearCwsEnv();

test('me GETs /me', async () => {
  const { http, fetch } = makeClient([ok({ id: 'self' })]);
  const out = await new CoreService(http).me();
  assert.equal(fetch.requests[0].path, '/api/v1/me');
  assert.deepEqual(out, { id: 'self' });
});

test('memberList maps kind/search + PageParams (pageSize→page_size, limit alias)', async () => {
  const { http, fetch } = makeClient([ok([])]);
  await new CoreService(http).memberList({ type: 'agent', q: 'bot', limit: 50 });
  assert.equal(fetch.requests[0].path, '/api/v1/members');
  assert.equal(fetch.requests[0].query.kind, 'agent');
  assert.equal(fetch.requests[0].query.search, 'bot');
  assert.equal(fetch.requests[0].query.page_size, '50');
});

test('agentProfiles folds capabilities:true into include and repeats member_id', async () => {
  const { http, fetch } = makeClient([ok([])]);
  await new CoreService(http).agentProfiles({ projectId: 'p1', memberIds: ['a', 'b'], capabilities: true });
  assert.equal(fetch.requests[0].path, '/api/v1/agent-profiles');
  assert.equal(fetch.requests[0].query.project_id, 'p1');
  assert.deepEqual(fetch.requests[0].searchParams.getAll('member_id'), ['a', 'b']);
  assert.equal(fetch.requests[0].query.include, 'capabilities');
});

test('selfRename PATCHes /me and mirrors the name into config; returns orgs_synced', async () => {
  const { http, fetch } = makeClient([ok({ display_name: 'Neo', identity_id: 'id1' })]);
  const cfg = { orgs: { acme: { self: {} }, beta: { self: { name: 'old' } } } };
  const config = {
    enabledOrgs: () => [{ slug: 'acme' }, { slug: 'beta' }],
    updateConfig: (fn) => { fn(cfg); return cfg; },
  };
  const out = await new CoreService(http, config).selfRename({ name: '  Neo  ' });
  assert.equal(fetch.requests[0].method, 'PATCH');
  assert.equal(fetch.requests[0].path, '/api/v1/me');
  assert.deepEqual(fetch.requests[0].body, { display_name: 'Neo' });
  assert.deepEqual(out, { display_name: 'Neo', identity_id: 'id1', orgs_synced: ['acme', 'beta'] });
  assert.equal(cfg.orgs.acme.self.name, 'Neo');
  assert.equal(cfg.orgs.beta.self.name, 'Neo');
});

test('selfRename works without a config provider (orgs_synced empty)', async () => {
  const { http } = makeClient([ok({ display_name: 'Trin' })]);
  const out = await new CoreService(http).selfRename({ displayName: 'Trin' });
  assert.deepEqual(out.orgs_synced, []);
});

test('selfRename rejects a blank name with status 400', async () => {
  const { http } = makeClient([ok()]);
  await assert.rejects(() => new CoreService(http).selfRename({ name: '   ' }), (e) => {
    assert.match(e.message, /non-empty/);
    assert.equal(e.status, 400);
    return true;
  });
});

test('orgSwitch posts an empty body to the switch endpoint', async () => {
  const { http, fetch } = makeClient([ok({ access_token: 'jwt' })]);
  await new CoreService(http).orgSwitch({ orgId: 'o2' });
  assert.equal(fetch.requests[0].method, 'POST');
  assert.equal(fetch.requests[0].path, '/api/v1/organizations/o2/switch');
  assert.deepEqual(fetch.requests[0].body, {});
});

test('projectList defaults status to active', async () => {
  const { http, fetch } = makeClient([ok([])]);
  await new CoreService(http).projectList({});
  assert.equal(fetch.requests[0].query.status, 'active');
});

test('agentDomain delegates to the injected provider', async () => {
  const { http } = makeClient([ok()]);
  const provider = async () => ({ ok: true, source: 'core', base_url: 'https://x' });
  const out = await createCoreService(http, null, provider).agentDomain();
  assert.deepEqual(out, { ok: true, source: 'core', base_url: 'https://x' });
});

test('agentDomain throws without a provider', async () => {
  const { http } = makeClient([ok()]);
  await assert.rejects(() => new CoreService(http).agentDomain(), /requires an injected agentDomain/);
});

test('frontendUrl builds a URL via the http client (no network)', () => {
  const { http } = makeClient([ok()]);
  const out = new CoreService(http).frontendUrl({ path: '/knowledge?kb=x' });
  assert.deepEqual(out, { url: 'http://api.test/workspace/knowledge?kb=x' });
});

test('frontendUrl requires a path', () => {
  const { http } = makeClient([ok()]);
  assert.throws(() => new CoreService(http).frontendUrl({}), /path is required/);
});
