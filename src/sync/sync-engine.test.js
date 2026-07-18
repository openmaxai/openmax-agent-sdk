import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SyncEngine, SYNC_PAGE_SIZE, SYNC_MAX_EVENTS } from './sync-engine.js';

const quiet = { info() {}, warn() {}, error() {} };
const SYNC = '/api/v1/sync';
const ACK = '/api/v1/sync/ack';

// Routed fake CwsHttpClient. `routes` maps a full (apiPath-prefixed) path to a
// handler (fn(body, calls) or a static value). Records every postForOrg call.
function fakeHttp(routes = {}) {
  const calls = [];
  const http = {
    apiPath: (p) => `/api/v1${p}`,
    postForOrg: async (orgId, path, body) => {
      calls.push({ orgId, path, body });
      const h = routes[path];
      if (typeof h === 'function') return h(body, calls);
      return h === undefined ? {} : h;
    },
  };
  http.calls = calls;
  return http;
}

// A /sync handler that returns queued pages in order (then empty).
function pager(pages) {
  let i = 0;
  return () => pages[i++] ?? { events: [], has_more: false };
}

const org = { org_id: 'org-1' };

test('constructor validates required deps', () => {
  assert.throws(() => new SyncEngine({ onMessage: () => {} }), /requires a CwsHttpClient/);
  assert.throws(() => new SyncEngine({ http: fakeHttp() }), /requires an onMessage handler/);
});

test('syncMissedEvents: no-op on first-ever connect (sync_seq falsy)', async () => {
  const http = fakeHttp();
  const engine = new SyncEngine({ http, onMessage: async () => {}, logger: quiet });
  await engine.syncMissedEvents(org, { sync_seq: 0 });
  assert.equal(http.calls.length, 0);
});

test('syncMissedEvents: feeds events, advances + persists cursor, acks highest seq', async () => {
  const seen = [];
  const saved = [];
  const http = fakeHttp({
    [SYNC]: pager([
      { events: [
        { message_id: 'm1', conversation_id: 'c1', seq: 11 },
        { message_id: 'm2', conversation_id: 'c2', seq: 12 },
      ], has_more: false },
    ]),
  });
  const engine = new SyncEngine({
    http,
    onMessage: async (ev) => seen.push(ev),
    saveSession: (orgId, partial) => saved.push({ orgId, partial }),
    deviceId: 'dev-9',
    appVersion: '1.2.3',
    logger: quiet,
  });
  const sessionRef = { sync_seq: 10 };
  await engine.syncMissedEvents(org, sessionRef);

  assert.deepEqual(seen, [
    { id: 'm1', conversation_id: 'c1', seq: 11, _via: 'sync' },
    { id: 'm2', conversation_id: 'c2', seq: 12, _via: 'sync' },
  ]);
  assert.equal(sessionRef.sync_seq, 12);
  assert.deepEqual(saved, [{ orgId: 'org-1', partial: { sync_seq: 12 } }]);
  // First call is /sync with the starting cursor + device id.
  assert.equal(http.calls[0].path, SYNC);
  assert.deepEqual(http.calls[0].body, { since_seq: 10, device_id: 'dev-9', limit: SYNC_PAGE_SIZE });
  // Last call acks the highest processed seq.
  const ack = http.calls.find((c) => c.path === ACK);
  assert.deepEqual(ack.body, { device_id: 'dev-9', seq: 12, platform: 'agent', app_version: '1.2.3' });
});

test('syncMissedEvents: pages through has_more, threading the advancing cursor', async () => {
  const seen = [];
  const http = fakeHttp({
    [SYNC]: pager([
      { events: [{ message_id: 'm1', conversation_id: 'c1', seq: 11 }], has_more: true },
      { events: [{ message_id: 'm2', conversation_id: 'c2', seq: 12 }], has_more: false },
    ]),
  });
  const engine = new SyncEngine({ http, onMessage: async (ev) => seen.push(ev), logger: quiet });
  await engine.syncMissedEvents(org, { sync_seq: 10 });

  const syncCalls = http.calls.filter((c) => c.path === SYNC);
  assert.equal(syncCalls.length, 2);
  assert.equal(syncCalls[0].body.since_seq, 10);
  assert.equal(syncCalls[1].body.since_seq, 11, 'second page resumes from the advanced cursor');
  assert.equal(seen.length, 2);
});

test('syncMissedEvents: honours the per-sweep maxEvents cap', async () => {
  const seen = [];
  // Every page returns 2 events and always claims has_more.
  const http = fakeHttp({
    [SYNC]: (body) => ({
      events: [
        { message_id: `a${body.since_seq}`, conversation_id: 'c', seq: body.since_seq + 1 },
        { message_id: `b${body.since_seq}`, conversation_id: 'c', seq: body.since_seq + 2 },
      ],
      has_more: true,
    }),
  });
  const engine = new SyncEngine({ http, onMessage: async (ev) => seen.push(ev), maxEvents: 2, logger: quiet });
  await engine.syncMissedEvents(org, { sync_seq: 100 });

  assert.equal(http.calls.filter((c) => c.path === SYNC).length, 1, 'stops after the cap despite has_more');
  assert.equal(seen.length, 2);
});

test('syncMissedEvents: per-org in-flight guard prevents overlapping sweeps', async () => {
  const http = fakeHttp({
    [SYNC]: pager([{ events: [{ message_id: 'm1', conversation_id: 'c1', seq: 11 }], has_more: false }]),
  });
  const engine = new SyncEngine({ http, onMessage: async () => {}, logger: quiet });
  const sessionRef = { sync_seq: 10 };
  const p1 = engine.syncMissedEvents(org, sessionRef); // adds org_id to _inFlight synchronously
  const p2 = engine.syncMissedEvents(org, sessionRef); // sees in-flight → skips
  await Promise.all([p1, p2]);
  assert.equal(http.calls.filter((c) => c.path === SYNC).length, 1);
});

test('syncMissedEvents: skips events missing message_id / conversation_id', async () => {
  const seen = [];
  const http = fakeHttp({
    [SYNC]: pager([
      { events: [
        { conversation_id: 'c1', seq: 11 },                    // no message_id → skipped
        { message_id: 'm2', seq: 12 },                          // no conversation_id → skipped
        { message_id: 'm3', conversation_id: 'c3', seq: 13 },   // valid
      ], has_more: false },
    ]),
  });
  const engine = new SyncEngine({ http, onMessage: async (ev) => seen.push(ev), logger: quiet });
  const sessionRef = { sync_seq: 10 };
  await engine.syncMissedEvents(org, sessionRef);
  assert.deepEqual(seen.map((e) => e.id), ['m3']);
  assert.equal(sessionRef.sync_seq, 13);
});

test('syncMissedEvents: swallows errors (best-effort, retried on next reconnect)', async () => {
  const http = fakeHttp({ [SYNC]: () => { throw new Error('boom'); } });
  const warns = [];
  const engine = new SyncEngine({
    http, onMessage: async () => {},
    logger: { info() {}, warn: (m) => warns.push(String(m)), error() {} },
  });
  await engine.syncMissedEvents(org, { sync_seq: 10 }); // must not throw
  assert.ok(warns.some((w) => /sync failed/.test(w)));
});

// ── #5: gap-sync floor — re-pull a hole BELOW the persisted cursor ────────────
// The inbox-ledger calls onGapSync(ackedSeq) with its DURABLE watermark. When
// the sync cursor has run ahead of that watermark (a live delivery advanced the
// cursor via a concurrent sweep, then FAILED, so the ledger never recorded that
// seq), the sweep must start from the lower floor or the hole is unrecoverable.

test('syncMissedEvents: gap-sync floor re-pulls a hole below the cursor (issue #5)', async () => {
  const seen = [];
  const allEvents = [
    { message_id: 'm8', conversation_id: 'c1', seq: 8 },
    { message_id: 'm9', conversation_id: 'c1', seq: 9 },
    { message_id: 'm10', conversation_id: 'c1', seq: 10 },
  ];
  // Realistic /sync: only returns events strictly above the requested since_seq.
  const http = fakeHttp({
    [SYNC]: (body) => ({ events: allEvents.filter((e) => e.seq > body.since_seq), has_more: false }),
  });
  const engine = new SyncEngine({ http, onMessage: async (ev) => seen.push(ev), logger: quiet });
  // cursor=10 (ahead), ledger acked_seq=7 passed as the floor → sweep from 7.
  const sessionRef = { sync_seq: 10 };
  await engine.syncMissedEvents(org, sessionRef, 7);

  assert.equal(http.calls[0].body.since_seq, 7, 'sweep floored at the ledger acked_seq, not the cursor');
  assert.deepEqual(seen.map((e) => e.id), ['m8', 'm9', 'm10'],
    'the hole at seq 8 (below the cursor) was re-pulled');
});

test('syncMissedEvents: a lower gap-sync floor never rewinds the persisted cursor', async () => {
  const saved = [];
  // Only seq 8 comes back (nothing above the cursor).
  const http = fakeHttp({
    [SYNC]: (body) => ({ events: [{ message_id: 'm8', conversation_id: 'c1', seq: 8 }].filter((e) => e.seq > body.since_seq), has_more: false }),
  });
  const engine = new SyncEngine({
    http, onMessage: async () => {},
    saveSession: (orgId, partial) => saved.push(partial), logger: quiet,
  });
  const sessionRef = { sync_seq: 10 };
  await engine.syncMissedEvents(org, sessionRef, 7);
  assert.equal(sessionRef.sync_seq, 10, 'cursor held at 10 — a lower-floor sweep does not rewind it');
  assert.deepEqual(saved, [], 'no cursor persist when the sweep would only lower it');
});

test('syncMissedEvents: an omitted floor sweeps from the cursor exactly as before', async () => {
  const http = fakeHttp({
    [SYNC]: pager([{ events: [{ message_id: 'm1', conversation_id: 'c1', seq: 11 }], has_more: false }]),
  });
  const engine = new SyncEngine({ http, onMessage: async () => {}, logger: quiet });
  await engine.syncMissedEvents(org, { sync_seq: 10 }); // no floor arg
  assert.equal(http.calls[0].body.since_seq, 10, 'no floor → sweeps from the cursor');
});

test('initSyncSeq: seeks to the inbox end via next_cursor and persists', async () => {
  const saved = [];
  const http = fakeHttp({
    [SYNC]: pager([
      { events: [{ seq: 5 }], has_more: true, next_cursor: 5 },
      { events: [{ seq: 9 }], has_more: false, next_cursor: 9 },
    ]),
  });
  const engine = new SyncEngine({
    http, onMessage: async () => {},
    saveSession: (orgId, partial) => saved.push({ orgId, partial }),
    logger: quiet,
  });
  const sessionRef = { sync_seq: 0 };
  await engine.initSyncSeq(org, sessionRef);
  assert.equal(sessionRef.sync_seq, 9);
  assert.deepEqual(saved, [{ orgId: 'org-1', partial: { org_id: 'org-1', sync_seq: 9 } }]);
});

test('initSyncSeq: falls back to the last event seq when next_cursor is absent', async () => {
  const http = fakeHttp({
    [SYNC]: pager([{ events: [{ seq: 3 }, { seq: 7 }], has_more: false }]),
  });
  const engine = new SyncEngine({ http, onMessage: async () => {}, logger: quiet });
  const sessionRef = { sync_seq: 0 };
  await engine.initSyncSeq(org, sessionRef);
  assert.equal(sessionRef.sync_seq, 7);
});

test('ackSync: posts /sync/ack and never throws on failure', async () => {
  const http = fakeHttp({ [ACK]: () => { throw new Error('ack down'); } });
  const engine = new SyncEngine({ http, onMessage: async () => {}, deviceId: 'd', appVersion: 'v', logger: quiet });
  await engine.ackSync(org, 42); // must not throw
  assert.deepEqual(http.calls[0].body, { device_id: 'd', seq: 42, platform: 'agent', app_version: 'v' });
});

test('exported caps match the comm-bridge defaults', () => {
  assert.equal(SYNC_PAGE_SIZE, 100);
  assert.equal(SYNC_MAX_EVENTS, 2000);
});
