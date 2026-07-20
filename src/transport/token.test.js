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

// ── api_key binding: cache is scoped to the api_key that minted the JWT ─────────
// The disk cache key is org-only (`tokens/<org>.json`). Before this binding, a
// JWT minted from api_key A was reused verbatim after the config swapped to
// api_key B for the SAME org — the agent then authenticated as the wrong
// identity. Each record now stores `apiKeyFp`; a mismatch (or a legacy record
// with no fp) is a cache miss that forces a fresh exchange.

test('same api_key reuses the persisted token across a fresh TokenManager (no re-exchange)', async () => {
  const storage = memoryStorage();
  let exchanges = 0;
  const fetch = fakeFetch(() => {
    exchanges += 1;
    return { json: { data: { access_token: `AT${exchanges}`, access_token_expires_at: FUTURE, refresh_token: 'R' } } };
  });
  const mk = () => new TokenManager({ apiKey: 'cwsk_same', coreUrl: 'http://core.test', storage, fetch, logger: quietLogger });

  const a = await mk().getAccessToken('org1');   // cold: exchange + persist (with fp)
  const b = await mk().getAccessToken('org1');   // fresh manager, same key + storage → reload from disk
  assert.equal(a, 'AT1');
  assert.equal(b, 'AT1', 'persisted token reused for the matching api_key');
  assert.equal(exchanges, 1, 'no re-exchange when the api_key is unchanged');
  // The persisted record carries a fingerprint (a hash, not the api_key).
  const persisted = JSON.parse(await storage.get('tokens/org1.json'));
  assert.ok(persisted.apiKeyFp, 'record stores an api_key fingerprint');
  assert.notEqual(persisted.apiKeyFp, 'cwsk_same', 'fingerprint is not the raw api_key');
});

test('changed api_key (same org) is a cache miss → re-exchange as the new identity', async () => {
  const storage = memoryStorage();
  let exchanges = 0;
  const fetch = fakeFetch((url, opts) => {
    exchanges += 1;
    // Surface which api_key minted this token so we can assert the identity swap.
    const who = opts.headers.Authorization;
    return { json: { data: { access_token: `AT-${who}`, access_token_expires_at: FUTURE, refresh_token: 'R' } } };
  });

  const first = new TokenManager({ apiKey: 'cwsk_bot2', coreUrl: 'http://core.test', storage, fetch, logger: quietLogger });
  const t1 = await first.getAccessToken('org1');
  assert.equal(t1, 'AT-Bearer cwsk_bot2');
  assert.equal(exchanges, 1);

  // Config swaps to a different api_key for the SAME org (identical storage/key).
  const second = new TokenManager({ apiKey: 'cwsk_bot4', coreUrl: 'http://core.test', storage, fetch, logger: quietLogger });
  const t2 = await second.getAccessToken('org1');
  assert.equal(t2, 'AT-Bearer cwsk_bot4', 'stale JWT discarded; re-exchanged as the new identity');
  assert.equal(exchanges, 2, 'api_key change forced a fresh exchange');
  // Persisted record is now bound to the new api_key.
  const persisted = JSON.parse(await storage.get('tokens/org1.json'));
  assert.equal(persisted.access_token, 'AT-Bearer cwsk_bot4');
});

test('legacy persisted record with no fingerprint is treated as a miss → re-exchange', async () => {
  const storage = memoryStorage();
  // Simulate a record written by an older SDK version: valid, unexpired, but no apiKeyFp.
  await storage.set('tokens/org1.json', JSON.stringify({
    access_token: 'LEGACY_AT',
    access_token_expires_at: Date.now() + 3600_000,
    refresh_token: 'LEGACY_RT',
  }));
  let exchanges = 0;
  const fetch = fakeFetch((url) => {
    if (url.endsWith('/auth/refresh')) return { status: 500, json: { error: 'legacy refresh must not be used' } };
    exchanges += 1;
    return { json: { data: { access_token: 'FRESH_AT', access_token_expires_at: FUTURE, refresh_token: 'R' } } };
  });
  const tm = new TokenManager({ apiKey: 'cwsk_new', coreUrl: 'http://core.test', storage, fetch, logger: quietLogger });

  const token = await tm.getAccessToken('org1');
  assert.equal(token, 'FRESH_AT', 'legacy fp-less record ignored; fresh exchange performed');
  assert.equal(exchanges, 1);
  const persisted = JSON.parse(await storage.get('tokens/org1.json'));
  assert.ok(persisted.apiKeyFp, 'record upgraded to carry a fingerprint');
});

// ── P1-C: a token request must not follow a redirect off the core origin ───────
// Every token call carries a Bearer credential; native fetch would re-send it to
// the redirect target. redirect:'manual' + a same-origin guard fails closed so
// the credential never leaves cws-core.
function redirectFetch(steps) {
  const calls = [];
  const queue = [...steps];
  const fn = async (url, opts = {}) => {
    calls.push({ url, opts, body: opts.body ? JSON.parse(opts.body) : undefined });
    const s = queue.shift();
    if (!s) throw new Error('redirectFetch: no more queued responses');
    const { status = 200, location = null, json } = s;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (k) => (String(k).toLowerCase() === 'location' ? location : null) },
      async text() { return JSON.stringify(json ?? {}); },
    };
  };
  fn.calls = calls;
  return fn;
}

test('P1-C: a token request that 302s off the core origin fails closed (credential not leaked)', async () => {
  const fetch = redirectFetch([{ status: 302, location: 'https://evil.example.com/steal' }]);
  const tm = new TokenManager({ apiKey: 'cwsk_test', coreUrl: 'http://core.test', fetch, logger: quietLogger });
  await assert.rejects(() => tm.exchange(''), /cross-origin redirect/);
  // The redirect target was never requested → the api_key Bearer never reached it.
  assert.equal(fetch.calls.length, 1, 'redirect target never requested');
  assert.equal(fetch.calls[0].url, 'http://core.test/auth/agent/token');
  assert.equal(fetch.calls[0].opts.headers.Authorization, 'Bearer cwsk_test');
});

test('P1-C: a same-origin token redirect is followed', async () => {
  const fetch = redirectFetch([
    { status: 302, location: 'http://core.test/auth/agent/token/v2' },
    { status: 200, json: { data: { access_token: 'AT', access_token_expires_at: FUTURE, refresh_token: 'R' } } },
  ]);
  const tm = new TokenManager({ apiKey: 'cwsk_test', coreUrl: 'http://core.test', fetch, logger: quietLogger });
  const token = await tm.exchange('');
  assert.equal(token, 'AT', 'same-origin redirect followed to the token response');
  assert.equal(fetch.calls.length, 2);
  assert.equal(fetch.calls[1].url, 'http://core.test/auth/agent/token/v2');
});

// ── P2-b: a FOLLOWED (same-origin) token redirect matches native fetch semantics ──
// Token calls are POSTs. Native fetch downgrades a 301/302 on a POST to a
// bodyless GET, but preserves method+body on 307/308. The old code re-POSTed the
// JSON body on a 301/302 (and only rewrote 303), diverging from fetch and
// breaking a core auth endpoint that legitimately redirects.

test('P2-b: a same-origin 302 on a token POST is followed as a bodyless GET (fetch parity)', async () => {
  const fetch = redirectFetch([
    { status: 302, location: 'http://core.test/auth/agent/token/v2' },
    { status: 200, json: { data: { access_token: 'AT', access_token_expires_at: FUTURE, refresh_token: 'R' } } },
  ]);
  const tm = new TokenManager({ apiKey: 'cwsk_test', coreUrl: 'http://core.test', fetch, logger: quietLogger });
  const token = await tm.exchange('org9');
  assert.equal(token, 'AT');
  assert.equal(fetch.calls.length, 2);
  // hop 1: original POST with a JSON body + content-type.
  assert.equal(fetch.calls[0].opts.method, 'POST');
  assert.deepEqual(fetch.calls[0].body, { org_id: 'org9' });
  assert.equal(fetch.calls[0].opts.headers['Content-Type'], 'application/json');
  // hop 2 (followed): downgraded to GET, body + content-type dropped.
  assert.equal(fetch.calls[1].opts.method, 'GET', '302 on POST → GET');
  assert.equal(fetch.calls[1].opts.body, undefined, 'the body is dropped on the followed GET');
  assert.equal(fetch.calls[1].opts.headers['Content-Type'], undefined, 'content-type dropped');
});

test('P2-b: a same-origin 307 on a token POST preserves method + body + content-type (fetch parity)', async () => {
  const fetch = redirectFetch([
    { status: 307, location: 'http://core.test/auth/agent/token/v2' },
    { status: 200, json: { data: { access_token: 'AT', access_token_expires_at: FUTURE, refresh_token: 'R' } } },
  ]);
  const tm = new TokenManager({ apiKey: 'cwsk_test', coreUrl: 'http://core.test', fetch, logger: quietLogger });
  const token = await tm.exchange('org9');
  assert.equal(token, 'AT');
  assert.equal(fetch.calls[1].opts.method, 'POST', '307 preserves POST');
  assert.deepEqual(fetch.calls[1].body, { org_id: 'org9' }, '307 preserves the body');
  assert.equal(fetch.calls[1].opts.headers['Content-Type'], 'application/json', '307 preserves content-type');
});

test('P2-b: a same-origin 303 on a token POST downgrades to a bodyless GET (fetch parity)', async () => {
  const fetch = redirectFetch([
    { status: 303, location: 'http://core.test/auth/agent/token/done' },
    { status: 200, json: { data: { access_token: 'AT', access_token_expires_at: FUTURE, refresh_token: 'R' } } },
  ]);
  const tm = new TokenManager({ apiKey: 'cwsk_test', coreUrl: 'http://core.test', fetch, logger: quietLogger });
  await tm.exchange('org9');
  assert.equal(fetch.calls[1].opts.method, 'GET', '303 → GET');
  assert.equal(fetch.calls[1].opts.body, undefined, 'body dropped on 303');
  assert.equal(fetch.calls[1].opts.headers['Content-Type'], undefined, 'content-type dropped');
});
