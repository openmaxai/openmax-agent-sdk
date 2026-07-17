import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSystemSender, systemEventPriority } from './system-message.js';

test('isSystemSender: 顶层 sender_type=SYSTEM 命中（实时 WS 帧）', () => {
  assert.equal(isSystemSender({ sender_type: 'SYSTEM' }), true);
  assert.equal(isSystemSender({ sender_type: 'system' }), true);
});

test('isSystemSender: 嵌套 message.sender_type=SYSTEM 命中（get-message 详情）', () => {
  assert.equal(isSystemSender({ message: { sender_type: 'SYSTEM' } }), true);
});

test('isSystemSender: 人类/agent/缺省都不命中', () => {
  assert.equal(isSystemSender({ sender_type: 'HUMAN' }), false);
  assert.equal(isSystemSender({ sender_type: 'AGENT' }), false);
  assert.equal(isSystemSender({}), false);
  assert.equal(isSystemSender(null), false);
});

test('systemEventPriority: 无 systemEvent 返回 undefined（当前现网系统消息形态）', () => {
  assert.equal(
    systemEventPriority({ content: { content_type: 'text', body: { text: '[调度中心] …' } } }),
    undefined,
  );
  assert.equal(systemEventPriority({}), undefined);
});

test('systemEventPriority: urgent/high/normal → 1/2/3', () => {
  const mk = (priority) => ({ content: { metadata: { systemEvent: { priority } } } });
  assert.equal(systemEventPriority(mk('urgent')), 1);
  assert.equal(systemEventPriority(mk('high')), 2);
  assert.equal(systemEventPriority(mk('normal')), 3);
  assert.equal(systemEventPriority(mk('URGENT')), 1);
});

test('systemEventPriority: 顶层 metadata 与 message.content.metadata 两种落点都能读', () => {
  assert.equal(systemEventPriority({ metadata: { systemEvent: { priority: 'high' } } }), 2);
  assert.equal(
    systemEventPriority({ message: { content: { metadata: { systemEvent: { priority: 'urgent' } } } } }),
    1,
  );
});

test('systemEventPriority: systemEvent 存在但 priority 缺省/未知 → 3（normal）', () => {
  assert.equal(systemEventPriority({ content: { metadata: { systemEvent: { eventType: 'task.completed' } } } }), 3);
  assert.equal(systemEventPriority({ content: { metadata: { systemEvent: { priority: 'bogus' } } } }), 3);
});
