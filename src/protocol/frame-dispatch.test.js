import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyFrame,
  classifySystemEvent,
  createFrameDispatcher,
  FRAME_KIND,
} from './frame-dispatch.js';

test('classifyFrame: maps top-level types', () => {
  assert.equal(classifyFrame({ type: 'message' }), FRAME_KIND.MESSAGE);
  assert.equal(classifyFrame({ type: 'message_ack' }), FRAME_KIND.MESSAGE_ACK);
  assert.equal(classifyFrame({ type: 'system' }), FRAME_KIND.SYSTEM);
  assert.equal(classifyFrame({ type: 'error' }), FRAME_KIND.ERROR);
  assert.equal(classifyFrame({ type: 'ping' }), FRAME_KIND.HEARTBEAT);
  assert.equal(classifyFrame({ type: 'pong' }), FRAME_KIND.HEARTBEAT);
  assert.equal(classifyFrame({ type: 'typing' }), FRAME_KIND.PRESENCE);
  assert.equal(classifyFrame({ type: 'read_state_update' }), FRAME_KIND.PRESENCE);
  assert.equal(classifyFrame({ type: 'whatever' }), FRAME_KIND.UNKNOWN);
  assert.equal(classifyFrame({}), FRAME_KIND.UNKNOWN);
});

test('classifySystemEvent: recall / edit / config / connection / channel / null', () => {
  assert.equal(classifySystemEvent('message.recalled'), 'recall');
  assert.equal(classifySystemEvent('message.deleted'), 'recall');
  assert.equal(classifySystemEvent('message.updated'), 'edit');
  assert.equal(classifySystemEvent('agent.config.dm_policy_changed'), 'config_update');
  assert.equal(classifySystemEvent('connection.authorized'), 'connection');
  assert.equal(classifySystemEvent('channel.bind'), 'channel');
  assert.equal(classifySystemEvent('message.created'), null);
  assert.equal(classifySystemEvent('message.reaction.added'), null);
  assert.equal(classifySystemEvent(''), null);
});

test('classifySystemEvent: defensive fallback for naming drift', () => {
  assert.equal(classifySystemEvent('message.edited'), 'edit');
  assert.equal(classifySystemEvent('something.recall.weird'), 'recall');
});

test('dispatcher: routes message frames to onMessage', () => {
  const seen = [];
  const onFrame = createFrameDispatcher({ onMessage: (f) => seen.push(f) });
  const frame = { type: 'message', payload: { message_id: 'm1' } };
  onFrame(frame);
  assert.deepEqual(seen, [frame]);
});

test('dispatcher: system frame passes classified kind to onSystem', () => {
  const seen = [];
  const onFrame = createFrameDispatcher({ onSystem: (f, kind) => seen.push([f.payload.event, kind]) });
  onFrame({ type: 'system', payload: { event: 'message.recalled', conversation_id: 'c' } });
  onFrame({ type: 'system', payload: { event: 'agent.config.owner_changed' } });
  assert.deepEqual(seen, [['message.recalled', 'recall'], ['agent.config.owner_changed', 'config_update']]);
});

test('dispatcher: rejected async handler routed to logger (no throw)', async () => {
  const warns = [];
  const onFrame = createFrameDispatcher(
    { onMessage: async () => { throw new Error('boom'); } },
    { warn: (...a) => warns.push(a.join(' ')) },
  );
  onFrame({ type: 'message', payload: {} });
  await new Promise((r) => setImmediate(r)); // let the rejection settle
  assert.ok(warns.some((w) => w.includes('onMessage') && w.includes('boom')));
});

test('dispatcher: unknown frame warns and calls onUnknown', () => {
  const warns = [];
  const unknown = [];
  const onFrame = createFrameDispatcher(
    { onUnknown: (f, kind) => unknown.push(kind) },
    { warn: (...a) => warns.push(a.join(' ')) },
  );
  onFrame({ type: 'mystery' });
  assert.deepEqual(unknown, [FRAME_KIND.UNKNOWN]);
  assert.ok(warns.some((w) => w.includes('unknown frame type')));
});

test('dispatcher: heartbeat frames are handled (transport already replied)', () => {
  const beats = [];
  const onFrame = createFrameDispatcher({ onHeartbeat: (f) => beats.push(f.type) });
  onFrame({ type: 'ping' });
  onFrame({ type: 'pong' });
  assert.deepEqual(beats, ['ping', 'pong']);
});

test('dispatcher: onFrameType observability hook fires; its throw never breaks dispatch', () => {
  const types = [];
  let delivered = false;
  const onFrame = createFrameDispatcher({
    onFrameType: (t) => { types.push(t); throw new Error('observer boom'); },
    onMessage: () => { delivered = true; },
  });
  onFrame({ type: 'message', payload: {} });
  assert.deepEqual(types, ['message']);
  assert.equal(delivered, true);
});

test('dispatcher: ignores non-object frames', () => {
  const onFrame = createFrameDispatcher({ onMessage: () => { throw new Error('should not run'); } });
  assert.doesNotThrow(() => { onFrame(null); onFrame(undefined); onFrame('str'); });
});
