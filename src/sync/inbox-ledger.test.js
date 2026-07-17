import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInboxLedger } from './inbox-ledger.js';
import { memoryStorage } from '../providers.js';

const noop = () => {};

function makeLedger(overrides = {}) {
  const acks = [];
  const gaps = [];
  const clock = { t: 0 };
  const storage = overrides.storage || memoryStorage();
  const ledger = createInboxLedger('org-a', {
    onAck: (seq) => acks.push(seq),
    onGapSync: (seq) => gaps.push(seq),
    log: noop,
    storage,
    now: () => clock.t,
    gapTimeoutMs: 10_000,
    receivedCap: 3,
    persistDebounceMs: 0,
    ...overrides,
  });
  return { ledger, acks, gaps, clock, storage };
}

const flush = () => new Promise((r) => setTimeout(r, 5));

test('record: dedup + contiguous watermark advance', () => {
  const { ledger } = makeLedger();
  assert.equal(ledger.record(1), true);
  assert.equal(ledger.record(2), true);
  assert.equal(ledger.record(3), true);
  assert.equal(ledger.getAckedSeq(), 3);
  assert.equal(ledger.record(2), false, 'seq at/below watermark is a duplicate');
  assert.equal(ledger.record(3), false);
});

test('record: non-numeric / non-positive seq is treated as processable (returns true), not tracked', () => {
  const { ledger } = makeLedger();
  assert.equal(ledger.record(0), true);
  assert.equal(ledger.record(-5), true);
  assert.equal(ledger.record('x'), true);
  assert.equal(ledger.getAckedSeq(), 0);
});

test('out-of-order gap: watermark holds until the hole is filled', () => {
  const { ledger } = makeLedger();
  assert.equal(ledger.record(2), true); // 1 is missing
  assert.equal(ledger.getAckedSeq(), 0, 'watermark cannot advance past the gap');
  assert.equal(ledger.record(1), true); // fills the hole → 1,2 both contiguous
  assert.equal(ledger.getAckedSeq(), 2);
});

test('tick: fires onAck once the watermark has advanced', () => {
  const { ledger, acks } = makeLedger();
  ledger.record(1);
  ledger.record(2);
  ledger.tick();
  assert.deepEqual(acks, [2]);
  ledger.tick(); // no further advance → no repeat ack
  assert.deepEqual(acks, [2]);
});

test('tick: a persisted gap past gapTimeoutMs triggers onGapSync from the watermark', () => {
  const { ledger, gaps, clock } = makeLedger();
  ledger.record(2); // gap at 1
  clock.t = 1_000;
  ledger.tick();          // arms oldestGapTs = 1000
  assert.deepEqual(gaps, []);
  clock.t = 1_000 + 11_000; // exceeds gapTimeoutMs (10s) since the gap was armed
  ledger.tick();
  assert.deepEqual(gaps, [0], 'onGapSync called with the current watermark');
});

test('tick: received-set overflow past receivedCap triggers onGapSync and clears', () => {
  const { ledger, gaps } = makeLedger(); // receivedCap = 3
  ledger.record(5);
  ledger.record(6);
  ledger.record(7);
  ledger.record(8); // received size = 4 > cap
  ledger.tick();
  assert.deepEqual(gaps, [0]);
  // After the overflow clear, a contiguous fill from the watermark advances.
  assert.equal(ledger.record(1), true);
  assert.equal(ledger.getAckedSeq(), 1);
});

test('setAckedSeq: seeds the watermark and prunes now-acked pending entries', () => {
  const { ledger } = makeLedger();
  ledger.record(5); // gap; pending {5}
  ledger.setAckedSeq(10);
  assert.equal(ledger.getAckedSeq(), 10);
  assert.equal(ledger.record(5), false, 'below new watermark → duplicate');
  assert.equal(ledger.record(11), true);
  assert.equal(ledger.getAckedSeq(), 11);
});

test('load: restores acked_seq + pending from storage', async () => {
  const storage = memoryStorage();
  await storage.set('inbox-org-a.json', JSON.stringify({ acked_seq: 7, received: [9, 10] }));
  const { ledger } = makeLedger({ storage });
  await ledger.load();
  assert.equal(ledger.getAckedSeq(), 7);
  // 8 fills the hole → 8,9,10 all contiguous.
  assert.equal(ledger.record(8), true);
  assert.equal(ledger.getAckedSeq(), 10);
});

test('load: missing/corrupt value starts fresh (no throw)', async () => {
  const storage = memoryStorage();
  await storage.set('inbox-org-a.json', 'not json{');
  const { ledger } = makeLedger({ storage });
  await ledger.load();
  assert.equal(ledger.getAckedSeq(), 0);
});

test('persist: debounced write lands in storage', async () => {
  const { ledger, storage } = makeLedger();
  ledger.record(1);
  ledger.record(2);
  await flush();
  const raw = await storage.get('inbox-org-a.json');
  assert.equal(JSON.parse(raw).acked_seq, 2);
});

test('stop: issues a final best-effort persist and can be awaited', async () => {
  const { ledger, storage } = makeLedger();
  ledger.record(1);
  ledger.record(2);
  ledger.start();
  await ledger.stop();
  const raw = await storage.get('inbox-org-a.json');
  assert.deepEqual(JSON.parse(raw), { acked_seq: 2, received: [] });
});
