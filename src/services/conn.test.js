import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConnService, createConnService } from './conn.js';
import { makeClient, ok, clearCwsEnv } from './_fixtures.js';

clearCwsEnv();

test('list uses the injected self-member resolver by default', async () => {
  const { http, fetch } = makeClient([ok([])]);
  const conn = new ConnService(http, null, () => 'self-9');
  await conn.list({});
  assert.equal(fetch.requests[0].path, '/api/v1/connect/agents/self-9/connections');
});

test('list prefers an explicit agentMemberId param', async () => {
  const { http, fetch } = makeClient([ok([])]);
  await new ConnService(http, null, () => 'self-9').list({ agentMemberId: 'other-1' });
  assert.equal(fetch.requests[0].path, '/api/v1/connect/agents/other-1/connections');
});

test('list throws when no agent member id can be resolved', () => {
  const { http } = makeClient([ok()]);
  assert.throws(() => new ConnService(http).list({}), (e) => {
    assert.match(e.message, /cannot resolve agent member_id/);
    assert.equal(e.status, 400);
    return true;
  });
});

test('acquire posts to the credential endpoint with agent_member_id query', async () => {
  const { http, fetch } = makeClient([ok({ credential_mode: 'direct', access_token: 't' })]);
  await new ConnService(http, null, () => 'self-9').acquire({ connectionId: 'conn-1' });
  assert.equal(fetch.requests[0].method, 'POST');
  assert.equal(fetch.requests[0].path, '/api/v1/connect/connections/conn-1/credential');
  assert.equal(fetch.requests[0].query.agent_member_id, 'self-9');
});

test('acquire requires connectionId', () => {
  const { http } = makeClient([ok()]);
  assert.throws(() => new ConnService(http, null, () => 'self-9').acquire({}), /connectionId is required/);
});

test('proxy forwards method/url/headers/body plus agent_member_id', async () => {
  const { http, fetch } = makeClient([ok()]);
  await new ConnService(http, null, () => 'self-9').proxy({
    connectionId: 'conn-1', method: 'POST', url: 'https://api/x', headers: { 'X-A': '1' }, body: { k: 'v' },
  });
  assert.equal(fetch.requests[0].path, '/api/v1/connect/connections/conn-1/proxy');
  assert.deepEqual(fetch.requests[0].body, {
    agent_member_id: 'self-9', method: 'POST', url: 'https://api/x', headers: { 'X-A': '1' }, body: { k: 'v' },
  });
});

test('status GETs the connection detail path', async () => {
  const { http, fetch } = makeClient([ok({ id: 'conn-1' })]);
  await new ConnService(http).status({ connectionId: 'conn-1' });
  assert.equal(fetch.requests[0].path, '/api/v1/connect/connections/conn-1');
});

test('cached shapes storage records into the summary view', () => {
  const { http } = makeClient([ok()]);
  const storage = {
    listCredentials: () => [
      { connectionId: 'c1', data: { credential_mode: 'direct', access_token: 'x' } },
      { connectionId: 'c2', data: { credential_mode: 'proxy', proxy_ref: 'r' } },
      { connectionId: 'c3', data: null },
    ],
  };
  const out = createConnService(http, storage).cached();
  assert.equal(out.count, 3);
  assert.deepEqual(out.credentials[0], { connection_id: 'c1', credential_mode: 'direct', has_access_token: true, has_proxy_ref: false });
  assert.deepEqual(out.credentials[1], { connection_id: 'c2', credential_mode: 'proxy', has_access_token: false, has_proxy_ref: true });
  assert.deepEqual(out.credentials[2], { connection_id: 'c3', error: 'parse_failed' });
});

test('cached degrades to empty without a storage provider', () => {
  const { http } = makeClient([ok()]);
  assert.deepEqual(new ConnService(http).cached(), { count: 0, credentials: [] });
});

test('clearCache delegates to storage and returns cleared ids', () => {
  const { http } = makeClient([ok()]);
  const cleared = [];
  const storage = { clearCredentials: (id) => { cleared.push(id); return id ? [id] : ['a', 'b']; } };
  assert.deepEqual(new ConnService(http, storage).clearCache({ connectionId: 'c1' }), { cleared: ['c1'] });
  assert.deepEqual(new ConnService(http, storage).clearCache({}), { cleared: ['a', 'b'] });
});
