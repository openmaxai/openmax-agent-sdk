import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CwsHttpClient } from './http.js';

// Keep tests hermetic regardless of ambient CWS env config.
for (const k of ['COCO_API_URL', 'COCO_API_KEY', 'COCO_ORG_ID', 'COCO_USER_TOKEN',
  'COCO_AUTH_TOKEN', 'COCO_API_PREFIX', 'COCO_DEVICE_ID', 'COCO_CLIENT_VERSION',
  'COCO_CF_ACCESS_CLIENT_ID', 'COCO_CF_ACCESS_CLIENT_SECRET']) {
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

// ── P1-2: trusted-origin credential gate (credential-leak guard) ──────────────
// CWS credentials (CF-Access service token + Bearer/JWT) must ONLY go to the
// trusted CWS origin — never to presigned S3/GCS/CDN or other cross-origin URLs.

const cfClient = (extra = {}) => new CwsHttpClient({
  baseUrl: 'https://api.cws.test',
  cfAccess: { cf_access: { client_id: 'cid', client_secret: 'csec' } },
  logger: quietLogger,
  ...extra,
});

test('P1-2: putBytes to a non-CWS (presigned) origin sends NO CWS credentials', async () => {
  const fetch = fakeFetch([{ status: 200, text: '' }]);
  const c = cfClient({ fetch });
  c.setApiKey('jwt-token'); // would become a Bearer on a trusted call
  await c.putBytes('https://storage.example.com/presigned/put?sig=abc',
    Buffer.from('x'), 'image/png', { 'x-amz-meta-test': '1' });
  const h = fetch.calls[0].opts.headers;
  assert.equal(h['CF-Access-Client-Id'], undefined, 'no CF-Access-Client-Id leaked to presigned origin');
  assert.equal(h['CF-Access-Client-Secret'], undefined, 'no CF-Access-Client-Secret leaked to presigned origin');
  assert.equal(h.Authorization, undefined, 'no Bearer/JWT leaked to presigned origin');
  assert.equal(h['x-amz-meta-test'], '1', 'server-supplied upload headers ARE sent');
  assert.equal(h['Content-Type'], 'image/png');
});

test('P1-2: getBytes from a non-CWS (CDN) origin sends NO CF-Access headers', async () => {
  const fetch = fakeFetch([{ status: 200, text: 'bytes' }]);
  const c = cfClient({ fetch });
  await c.getBytes('https://cdn.example.com/download/x?sig=abc');
  const h = fetch.calls[0].opts.headers;
  assert.equal(h['CF-Access-Client-Id'], undefined, 'no CF-Access-Client-Id leaked to CDN origin');
  assert.equal(h['CF-Access-Client-Secret'], undefined, 'no CF-Access-Client-Secret leaked to CDN origin');
});

test('P1-2: putBytes/getBytes to the trusted CWS origin DO carry CF-Access (positive control)', async () => {
  const fetch = fakeFetch([{ status: 200, text: '' }, { status: 200, text: 'bytes' }]);
  const c = cfClient({ fetch });
  await c.putBytes('https://api.cws.test/artifacts/upload/direct', Buffer.from('x'), 'image/png');
  const hp = fetch.calls[0].opts.headers;
  assert.equal(hp['CF-Access-Client-Id'], 'cid', 'CF-Access attached for same-origin PUT');
  assert.equal(hp['CF-Access-Client-Secret'], 'csec');
  await c.getBytes('https://api.cws.test/artifacts/download/direct');
  const hg = fetch.calls[1].opts.headers;
  assert.equal(hg['CF-Access-Client-Id'], 'cid', 'CF-Access attached for same-origin GET');
  assert.equal(hg['CF-Access-Client-Secret'], 'csec');
});

test('P1-2: an explicit trustedOrigins allowlist entry may receive CF-Access', async () => {
  const fetch = fakeFetch([{ status: 200, text: '' }]);
  const c = cfClient({ fetch, trustedOrigins: ['https://artifacts.cws.test'] });
  await c.putBytes('https://artifacts.cws.test/upload', Buffer.from('x'), 'image/png');
  const h = fetch.calls[0].opts.headers;
  assert.equal(h['CF-Access-Client-Id'], 'cid', 'allowlisted origin is trusted');
});

test('P1-2: a cross-origin absolute path through the REST client gets no CF-Access or Bearer', async () => {
  const fetch = fakeFetch([{ status: 200, json: { data: {}, request_id: 'r' } }]);
  const c = cfClient({ fetch });
  c.setApiKey('jwt-token');
  // An absolute cross-origin URL passed as a "path" must not be credentialed.
  await c.get('https://evil.example.com/steal');
  const h = fetch.calls[0].opts.headers;
  assert.equal(h['CF-Access-Client-Id'], undefined, 'no CF-Access to cross-origin absolute path');
  assert.equal(h.Authorization, undefined, 'no Bearer to cross-origin absolute path');
});
