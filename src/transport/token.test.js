import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TokenManager } from './token.js';
import { memoryStorage } from '../providers.js';

// Keep tests hermetic regardless of ambient CWS env config.
for (const k of ['COCO_API_URL', 'COCO_API_KEY', 'COCO_ORG_ID']) {
  delete process.env[k];
}

const quietLogger = { log() {}, warn() {}, error() {} };

function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url, opts, body: opts.body ? JSON.parse(opts.body) : undefined });
    const { status = 200, json } = handler(url, opts) || {};
    const bodyText = JSON.stringify(json);
    return {
      ok: status >= 200 && status < 300,
      status,
      async text() { return bodyText; },
    };
  };
  fn.calls = calls;
  return fn;
}

// Build an unsigned JWT (header.payload.sig) carrying the given claims.
function fakeJwt(claims) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64(claims)}.sig`;
}

const FUTURE = new Date(Date.now() + 3600_000).toISOString();

test('exchange posts api_key to /auth/agent/token and caches + persists the token', async () => {
  const storage = memoryStorage();
  const fetch = fakeFetch(() => ({
    json: { data: { access_token: 'AT1', access_token_expires_at: FUTURE, refresh_token: 'RT1' } },
  }));
  const tm = new TokenManager({ apiKey: 'cwsk_test', coreUrl: 'http://core.test', storage, fetch, logger: quietLogger });

  const token = await tm.exchange('');
  assert.equal(token, 'AT1');
  // Bearer api_key on the exchange call.
  assert.equal(fetch.calls[0].url, 'http://core.test/auth/agent/token');
  assert.equal(fetch.calls[0].opts.headers.Authorization, 'Bearer cwsk_test');
  // Persisted to storage under the identity key.
  const persisted = JSON.parse(await storage.get('tokens/_identity.json'));
  assert.equal(persisted.access_token, 'AT1');
});

test('getAccessToken returns the cached token without a second network call', async () => {
  const fetch = fakeFetch(() => ({
    json: { data: { access_token: 'AT2', access_token_expires_at: FUTURE, refresh_token: 'RT2' } },
  }));
  const tm = new TokenManager({ apiKey: 'k', coreUrl: 'http://core.test', fetch, logger: quietLogger });
  const a = await tm.getAccessToken('org1');
  const b = await tm.getAccessToken('org1');
  assert.equal(a, 'AT2');
  assert.equal(b, 'AT2');
  assert.equal(fetch.calls.length, 1, 'second call served from cache');
});

test('getWsTicket exchanges an org JWT then posts /auth/ws-ticket', async () => {
  const fetch = fakeFetch((url) => {
    if (url.endsWith('/auth/agent/token')) {
      return { json: { data: { access_token: 'ORGJWT', access_token_expires_at: FUTURE, refresh_token: 'R' } } };
    }
    if (url.endsWith('/auth/ws-ticket')) {
      return { json: { data: { ticket: 'TICKET-123', expires_at: FUTURE } } };
    }
    return { status: 404, json: {} };
  });
  const tm = new TokenManager({ apiKey: 'k', coreUrl: 'http://core.test', fetch, logger: quietLogger });
  const ticket = await tm.getWsTicket('org1');
  assert.equal(ticket, 'TICKET-123');
  const wsCall = fetch.calls.find((c) => c.url.endsWith('/auth/ws-ticket'));
  assert.deepEqual(wsCall.body, { org_id: 'org1' });
  assert.equal(wsCall.opts.headers.Authorization, 'Bearer ORGJWT');
});

test('getWsTicket rejects when no org can be resolved', async () => {
  const tm = new TokenManager({ apiKey: 'k', resolveDefaultOrgId: () => '', logger: quietLogger });
  await assert.rejects(() => tm.getWsTicket(''), /org_id required/);
});

test('invalidate clears the in-memory cache (next call reloads from storage)', async () => {
  // Count storage reads to prove the in-memory cache was dropped. A still-valid
  // persisted token is reused on reload — faithful to the source: invalidate
  // only clears memory, disk reload returns the unexpired token, no re-exchange.
  const inner = memoryStorage();
  let gets = 0;
  const storage = { get: (k) => { gets += 1; return inner.get(k); }, set: (k, v) => inner.set(k, v) };
  let exchanges = 0;
  const fetch = fakeFetch(() => {
    exchanges += 1;
    return { json: { data: { access_token: `AT${exchanges}`, access_token_expires_at: FUTURE, refresh_token: 'R' } } };
  });
  const tm = new TokenManager({ apiKey: 'k', coreUrl: 'http://core.test', storage, fetch, logger: quietLogger });

  await tm.getAccessToken('org1');          // cache miss → exchange (+ storage.get, +write)
  const getsAfterFirst = gets;
  await tm.getAccessToken('org1');          // served from in-memory cache → no storage.get
  assert.equal(gets, getsAfterFirst, 'cached call does not touch storage');

  tm.invalidate('org1');
  await tm.getAccessToken('org1');          // cache cleared → reload from storage
  assert.ok(gets > getsAfterFirst, 'invalidate forced a storage reload');
  assert.equal(exchanges, 1, 'still-valid persisted token is reused (no re-exchange)');
});

test('org-scoped exchange surfaces the member_id claim via onMemberId', async () => {
  const seen = [];
  const jwt = fakeJwt({ member_id: 'mem-42' });
  const fetch = fakeFetch(() => ({
    json: { data: { access_token: jwt, access_token_expires_at: FUTURE, refresh_token: 'R' } },
  }));
  const tm = new TokenManager({
    apiKey: 'k',
    coreUrl: 'http://core.test',
    fetch,
    logger: quietLogger,
    onMemberId: (orgId, memberId) => { seen.push([orgId, memberId]); },
  });
  await tm.exchange('org1');
  assert.deepEqual(seen, [['org1', 'mem-42']]);
});

test('exchange throws when no api_key is configured', async () => {
  const tm = new TokenManager({ logger: quietLogger });
  await assert.rejects(() => tm.exchange(''), /api_key not set/);
});
