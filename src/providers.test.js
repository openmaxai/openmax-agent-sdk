import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveProviders, memoryStorage, consoleLogger } from './providers.js';

test('resolveProviders fills defaults when nothing supplied', async () => {
  const p = resolveProviders();
  assert.equal(typeof p.storage.get, 'function');
  assert.equal(typeof p.runtimeState.getMetrics, 'function');
  assert.equal(typeof p.inbound.deliver, 'function');
  assert.equal(p.logger, consoleLogger);
});

test('default inbound reports failure (no provider) rather than false-acking', async () => {
  const { inbound } = resolveProviders();
  const r = await inbound.deliver({ messageId: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.failureClass, 'no_inbound_provider');
});

test('memoryStorage round-trips and returns null for missing keys', async () => {
  const s = memoryStorage();
  assert.equal(await s.get('nope'), null);
  await s.set('k', 'v');
  assert.equal(await s.get('k'), 'v');
});

test('supplied providers override defaults', async () => {
  const custom = { async deliver() { return { ok: true, runtimeSession: 's1' }; } };
  const p = resolveProviders({ inbound: custom });
  const r = await p.inbound.deliver({});
  assert.equal(r.ok, true);
  assert.equal(r.runtimeSession, 's1');
});
