import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CwsHttpClient } from './http.js';

// Keep tests hermetic regardless of ambient CWS env config.
for (const k of ['COCO_API_URL', 'COCO_API_KEY', 'COCO_ORG_ID', 'COCO_USER_TOKEN',
  'COCO_AUTH_TOKEN', 'COCO_API_PREFIX', 'COCO_DEVICE_ID', 'COCO_CLIENT_VERSION']) {
  delete process.env[k];
}

const quietLogger = { log() {}, warn() {}, error() {} };

// Build a fake fetch that records calls and replays queued responses.
function fakeFetch(responses) {
  const calls = [];
  const queue = [...responses];
  const fn = async (url, opts = {}) => {
    calls.push({ url, opts });
    const next = queue.shift();
    if (!next) throw new Error('fakeFetch: no more queued responses');
    const { status = 200, json, text } = next;
    const bodyText = text !== undefined ? text : JSON.stringify(json);
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: `HTTP ${status}`,
      async text() { return bodyText; },
      async arrayBuffer() { return Buffer.from(bodyText); },
    };
  };
  fn.calls = calls;
  return fn;
}

test('apiPath uses default /api/v1 prefix', () => {
  const c = new CwsHttpClient({ logger: quietLogger });
  assert.equal(c.apiPath('/kbs'), '/api/v1/kbs');
});

test('apiPath honors constructor override', () => {
  const c = new CwsHttpClient({ apiPrefix: '/api/v2', logger: quietLogger });
  assert.equal(c.apiPath('/kbs'), '/api/v2/kbs');
});

test('get() unwraps the D8 single envelope', async () => {
  const fetch = fakeFetch([{ json: { data: { id: '1', name: 'x' }, request_id: 'r1' } }]);
  const c = new CwsHttpClient({ baseUrl: 'http://api.test', fetch, logger: quietLogger });
  const out = await c.get('/me');
  assert.deepEqual(out, { id: '1', name: 'x' });
  assert.equal(fetch.calls[0].url, 'http://api.test/me');
});

test('get() unwraps the D8 paginated envelope into { data, pagination }', async () => {
  const fetch = fakeFetch([{
    json: { data: [{ id: '1' }], pagination: { total: 1 }, request_id: 'r2' },
  }]);
  const c = new CwsHttpClient({ baseUrl: 'http://api.test', fetch, logger: quietLogger });
  const out = await c.get('/tasks');
  assert.deepEqual(out, { data: [{ id: '1' }], pagination: { total: 1 } });
});

test('query params are appended to the URL', async () => {
  const fetch = fakeFetch([{ json: { data: [], request_id: 'r3' } }]);
  const c = new CwsHttpClient({ baseUrl: 'http://api.test', fetch, logger: quietLogger });
  await c.get('/tasks', { status: 'open', tags: ['a', 'b'], skip: '' });
  const url = fetch.calls[0].url;
  assert.match(url, /^http:\/\/api\.test\/tasks\?/);
  assert.match(url, /status=open/);
  assert.match(url, /tags=a&tags=b/);
  assert.doesNotMatch(url, /skip=/); // empty string is dropped
});

test('HTTP error extracts nested error-envelope detail and .status', async () => {
  const fetch = fakeFetch([{
    status: 422,
    json: { error: { title: 'Bad', detail: 'name is required', code: 'X' }, request_id: 'r4' },
  }]);
  const c = new CwsHttpClient({ baseUrl: 'http://api.test', fetch, logger: quietLogger });
  await assert.rejects(
    () => c.post('/projects', {}),
    (err) => {
      assert.equal(err.message, 'name is required');
      assert.equal(err.status, 422);
      return true;
    },
  );
});

test('401 triggers one token invalidate + retry, then succeeds', async () => {
  const invalidated = [];
  const tokenManager = {
    async getAccessToken() { return 'jwt-token'; },
    invalidate(orgId) { invalidated.push(orgId); },
  };
  const fetch = fakeFetch([
    { status: 401, json: { error: { detail: 'expired' } } },
    { status: 200, json: { data: { ok: true }, request_id: 'r5' } },
  ]);
  const c = new CwsHttpClient({
    baseUrl: 'http://api.test',
    fetch,
    tokenManager,
    resolveDefaultOrgId: () => 'org1',
    logger: quietLogger,
  });
  const out = await c.getForOrg('org1', '/me');
  assert.deepEqual(out, { ok: true });
  assert.equal(fetch.calls.length, 2, 'retried once');
  assert.deepEqual(invalidated, ['org1']);
  // Second attempt carried a Bearer token from the token manager.
  assert.equal(fetch.calls[1].opts.headers.Authorization, 'Bearer jwt-token');
});

test('setApiKey override short-circuits the token manager', async () => {
  let tmCalled = false;
  const tokenManager = {
    async getAccessToken() { tmCalled = true; return 'jwt'; },
    invalidate() {},
  };
  const fetch = fakeFetch([{ json: { data: {}, request_id: 'r6' } }]);
  const c = new CwsHttpClient({ baseUrl: 'http://api.test', fetch, tokenManager, logger: quietLogger });
  c.setApiKey('override-key');
  await c.get('/me');
  assert.equal(tmCalled, false, 'token manager not consulted when override set');
  assert.equal(fetch.calls[0].opts.headers.Authorization, 'Bearer override-key');
});

test('frontendUrl mounts under the frontend base path', () => {
  const c = new CwsHttpClient({ baseUrl: 'http://api.test/', logger: quietLogger });
  assert.equal(c.frontendUrl('/knowledge?kb=x'), 'http://api.test/workspace/knowledge?kb=x');
});
