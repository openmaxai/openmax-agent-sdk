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

// ── P1-C: cross-origin redirects must NOT carry credentials (fail-closed) ──────
// Native fetch auto-follows 3xx and re-sends the request headers to the target.
// The client uses redirect:'manual' and follows ONLY same-origin/trusted hops,
// so a redirect from the CWS origin to another origin fails closed — the target
// origin is never even requested, so no CF-Access / Bearer can reach it.

// A fetch whose responses may be redirects (Location header) and which records
// every URL it was asked to fetch — so "the second origin was never requested"
// is directly observable.
function redirectFetch(steps) {
  const calls = [];
  const queue = [...steps];
  const fn = async (url, opts = {}) => {
    calls.push({ url, opts });
    const s = queue.shift();
    if (!s) throw new Error('redirectFetch: no more queued responses');
    const { status = 200, location = null, json, text } = s;
    const bodyText = text !== undefined ? text : JSON.stringify(json ?? { data: {}, request_id: 'r' });
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: `HTTP ${status}`,
      headers: { get: (k) => (String(k).toLowerCase() === 'location' ? location : null) },
      async text() { return bodyText; },
      async arrayBuffer() { return Buffer.from(bodyText); },
    };
  };
  fn.calls = calls;
  return fn;
}

test('P1-C: a credentialed REST call that 302s cross-origin fails closed (target never requested)', async () => {
  const fetch = redirectFetch([{ status: 302, location: 'https://evil.example.com/steal' }]);
  const c = cfClient({ fetch });
  c.setApiKey('jwt-token');
  await assert.rejects(() => c.get('/me'), /cross-origin redirect/);
  // Only the trusted CWS origin was fetched; the redirect target got nothing.
  assert.equal(fetch.calls.length, 1, 'the cross-origin redirect target was never requested');
  assert.equal(fetch.calls[0].url, 'https://api.cws.test/me');
  // (the legit first hop carried creds; the point is the SECOND origin did not)
  assert.equal(fetch.calls[0].opts.headers['CF-Access-Client-Id'], 'cid');
  assert.equal(fetch.calls[0].opts.headers.Authorization, 'Bearer jwt-token');
});

test('P1-C: a same-origin REST redirect is still followed (positive control)', async () => {
  const fetch = redirectFetch([
    { status: 302, location: 'https://api.cws.test/me/final' },
    { status: 200, json: { data: { id: 'me1' }, request_id: 'r' } },
  ]);
  const c = cfClient({ fetch });
  c.setApiKey('jwt-token');
  const out = await c.get('/me');
  assert.deepEqual(out, { id: 'me1' }, 'same-origin redirect followed to the final 200');
  assert.equal(fetch.calls.length, 2, 'followed exactly one same-origin hop');
  assert.equal(fetch.calls[1].url, 'https://api.cws.test/me/final');
  // Same trusted origin on both hops → creds legitimately re-applied.
  assert.equal(fetch.calls[1].opts.headers.Authorization, 'Bearer jwt-token');
  assert.equal(fetch.calls[1].opts.headers['CF-Access-Client-Id'], 'cid');
});

test('P1-C: a credentialed putBytes that 307s cross-origin fails closed', async () => {
  const fetch = redirectFetch([{ status: 307, location: 'https://evil.example.com/x' }]);
  const c = cfClient({ fetch });
  await assert.rejects(
    () => c.putBytes('https://api.cws.test/artifacts/upload', Buffer.from('x'), 'image/png'),
    /cross-origin redirect/,
  );
  assert.equal(fetch.calls.length, 1, 'no cross-origin follow — target never requested');
});

test('P1-C: a credentialed getBytes that 302s cross-origin fails closed', async () => {
  const fetch = redirectFetch([{ status: 302, location: 'https://evil.example.com/obj' }]);
  const c = cfClient({ fetch });
  await assert.rejects(() => c.getBytes('https://api.cws.test/artifacts/download'), /cross-origin redirect/);
  assert.equal(fetch.calls.length, 1, 'no cross-origin follow — target never requested');
});

test('P1-C: a NON-credentialed presigned getBytes follows redirects transparently (no regression)', async () => {
  const fetch = redirectFetch([
    { status: 302, location: 'https://cdn2.example.com/obj' },
    { status: 200, text: 'BYTES' },
  ]);
  const c = cfClient({ fetch });
  const buf = await c.getBytes('https://storage.example.com/presigned?sig=a');
  assert.equal(buf.toString(), 'BYTES', 'presigned cross-origin redirect followed (there are no CWS creds to leak)');
  assert.equal(fetch.calls.length, 2, 'the presigned redirect was followed');
  assert.equal(fetch.calls[0].opts.headers['CF-Access-Client-Id'], undefined, 'no CWS creds on hop 1');
  assert.equal(fetch.calls[1].opts.headers['CF-Access-Client-Id'], undefined, 'no CWS creds on hop 2');
});

// ── P2-b: a FOLLOWED redirect must match native fetch's method/body semantics ──
// The round-2 fix only rewrote 303 → GET, but native fetch also downgrades
// 301/302 on a POST to a bodyless GET, while preserving method+body on 307/308.
// The old code re-POSTed the JSON body/content-type on a 301/302, breaking REST
// endpoints that legitimately redirect a POST. These prove fetch-parity by
// asserting the SECOND (followed) request's method + body + content-type.

test('P2-b: a same-origin 302 on a POST is followed as a bodyless GET (fetch parity)', async () => {
  const fetch = redirectFetch([
    { status: 302, location: 'https://api.cws.test/thing/final' },
    { status: 200, json: { data: { ok: true }, request_id: 'r' } },
  ]);
  const c = cfClient({ fetch });
  c.setApiKey('jwt-token');
  await c.post('/thing', { a: 1 });
  assert.equal(fetch.calls.length, 2, 'the redirect was followed');
  // hop 1: the original POST carried a JSON body + content-type.
  assert.equal(fetch.calls[0].opts.method, 'POST');
  assert.equal(fetch.calls[0].opts.headers['Content-Type'], 'application/json');
  assert.equal(fetch.calls[0].opts.body, JSON.stringify({ a: 1 }));
  // hop 2 (followed): downgraded to GET, body + content-type dropped (fetch parity).
  assert.equal(fetch.calls[1].opts.method, 'GET', '302 on POST → GET');
  assert.equal(fetch.calls[1].opts.body, undefined, 'the body is dropped on the GET');
  assert.equal(fetch.calls[1].opts.headers['Content-Type'], undefined, 'content-type dropped');
  // same trusted origin on both hops → creds legitimately re-applied.
  assert.equal(fetch.calls[1].opts.headers.Authorization, 'Bearer jwt-token');
});

test('P2-b: a same-origin 307 on a POST preserves method + body + content-type (fetch parity)', async () => {
  const fetch = redirectFetch([
    { status: 307, location: 'https://api.cws.test/thing/final' },
    { status: 200, json: { data: { ok: true }, request_id: 'r' } },
  ]);
  const c = cfClient({ fetch });
  c.setApiKey('jwt-token');
  await c.post('/thing', { a: 1 });
  assert.equal(fetch.calls.length, 2);
  assert.equal(fetch.calls[1].opts.method, 'POST', '307 preserves POST');
  assert.equal(fetch.calls[1].opts.body, JSON.stringify({ a: 1 }), '307 preserves the body');
  assert.equal(fetch.calls[1].opts.headers['Content-Type'], 'application/json', '307 preserves content-type');
});

test('P2-b: a same-origin 303 downgrades any method to a bodyless GET (fetch parity)', async () => {
  const fetch = redirectFetch([
    { status: 303, location: 'https://api.cws.test/thing/result' },
    { status: 200, json: { data: { ok: true }, request_id: 'r' } },
  ]);
  const c = cfClient({ fetch });
  c.setApiKey('jwt-token');
  await c.post('/thing', { a: 1 });
  assert.equal(fetch.calls[1].opts.method, 'GET', '303 → GET');
  assert.equal(fetch.calls[1].opts.body, undefined, 'the body is dropped on a 303');
  assert.equal(fetch.calls[1].opts.headers['Content-Type'], undefined, 'content-type dropped');
});
