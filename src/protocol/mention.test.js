import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMentionRegistry } from './mention.js';
import { memoryStorage } from '../providers.js';

// ── recordParticipants ────────────────────────────────────────────────────────

test('resolveMentions canonicalizes a case-insensitive @name to the exact display name', async () => {
  const reg = createMentionRegistry({ storage: memoryStorage() });
  await reg.recordParticipants('c1', 'Alice Wong');
  assert.equal(await reg.resolveMentions('hey @alice wong, look', 'c1'), 'hey @Alice Wong, look');
  assert.equal(await reg.resolveMentions('hey @ALICE WONG!', 'c1'), 'hey @Alice Wong!');
});

test('resolveMentions matches the longest name first (longer wins over a shorter prefix)', async () => {
  const reg = createMentionRegistry({ storage: memoryStorage() });
  await reg.recordParticipants('c1', ['Alice', 'Alice Wong']);
  // "@Alice Wong" must canonicalize as the full name, not "@Alice" + " Wong".
  assert.equal(await reg.resolveMentions('ping @alice wong', 'c1'), 'ping @Alice Wong');
  // A bare "@Alice" still resolves to the short participant.
  assert.equal(await reg.resolveMentions('ping @alice', 'c1'), 'ping @Alice');
});

test('resolveMentions leaves unknown @handles and mention-free text untouched', async () => {
  const reg = createMentionRegistry({ storage: memoryStorage() });
  await reg.recordParticipants('c1', 'Bob');
  assert.equal(await reg.resolveMentions('hi @charlie', 'c1'), 'hi @charlie');
  assert.equal(await reg.resolveMentions('no mention here', 'c1'), 'no mention here');
  // Unknown conversation → passthrough.
  assert.equal(await reg.resolveMentions('@bob hello', 'other'), '@bob hello');
});

test('resolveMentions short-circuits empty / mention-free / missing-conversation input', async () => {
  const reg = createMentionRegistry({ storage: memoryStorage() });
  await reg.recordParticipants('c1', 'Bob');
  assert.equal(await reg.resolveMentions('', 'c1'), '');
  assert.equal(await reg.resolveMentions('plain', 'c1'), 'plain');
  assert.equal(await reg.resolveMentions('@bob', ''), '@bob');
});

test('recordParticipants dedupes by normalized name and keeps the latest casing', async () => {
  const storage = memoryStorage();
  const reg = createMentionRegistry({ storage });
  await reg.recordParticipants('c1', ['Alice', 'ALICE', '  alice  ']);
  const persisted = JSON.parse(await storage.get('mention-registry.json'));
  // One normalized key "alice"; value is the last-seen trimmed form.
  assert.deepEqual(Object.keys(persisted.c1), ['alice']);
  assert.equal(persisted.c1.alice, 'alice');
});

test('recordParticipants ignores empty conversationId and blank names', async () => {
  const storage = memoryStorage();
  const reg = createMentionRegistry({ storage });
  await reg.recordParticipants('', 'Alice');
  await reg.recordParticipants('c1', ['', '   ', null, undefined]);
  assert.equal(await storage.get('mention-registry.json'), null); // nothing persisted
});

test('registry persists across instances backed by the same storage', async () => {
  const storage = memoryStorage();
  const a = createMentionRegistry({ storage });
  await a.recordParticipants('c1', 'Dana');
  // A fresh instance (simulated restart) reads the persisted registry.
  const b = createMentionRegistry({ storage });
  assert.equal(await b.resolveMentions('yo @DANA', 'c1'), 'yo @Dana');
});

test('per-conversation name set is capped (oldest evicted)', async () => {
  const storage = memoryStorage();
  const reg = createMentionRegistry({ storage, maxNamesPerConv: 2 });
  await reg.recordParticipants('c1', ['One', 'Two', 'Three']);
  const persisted = JSON.parse(await storage.get('mention-registry.json'));
  // Cap=2 keeps the two most-recently inserted; "one" was evicted.
  assert.equal(Object.keys(persisted.c1).length, 2);
  assert.deepEqual(Object.keys(persisted.c1), ['two', 'three']);
});

test('a storage write failure never throws out of recordParticipants', async () => {
  const storage = {
    async get() { return null; },
    async set() { throw new Error('disk full'); },
  };
  const reg = createMentionRegistry({ storage });
  await assert.doesNotReject(reg.recordParticipants('c1', 'Alice'));
});

test('a name with regex metacharacters is matched literally', async () => {
  const reg = createMentionRegistry({ storage: memoryStorage() });
  await reg.recordParticipants('c1', 'A.B (dev)');
  assert.equal(await reg.resolveMentions('cc @a.b (DEV)', 'c1'), 'cc @A.B (dev)');
});
