import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  newClientMsgId,
  parseEndpoint,
  formatEndpoint,
  looksLikeMarkdown,
  parseMediaPrefix,
  splitMessage,
} from './message-codec.js';

test('newClientMsgId: c_ prefix + unique', () => {
  const a = newClientMsgId();
  const b = newClientMsgId();
  assert.match(a, /^c_[0-9a-f-]{36}$/);
  assert.notEqual(a, b);
});

test('parseEndpoint: minimal conversation id only', () => {
  const e = parseEndpoint('conv-123');
  assert.equal(e.conversationId, 'conv-123');
  assert.equal(e.type, 'dm');
});

test('parseEndpoint: reply/thread/parent suffixes', () => {
  const e = parseEndpoint('conv-1|reply:m1|thread:t1|parent:p1');
  assert.equal(e.conversationId, 'conv-1');
  assert.equal(e.replyTo, 'm1');
  assert.equal(e.threadConversationId, 't1');
  assert.equal(e.parentMessageId, 'p1');
  assert.equal(e.type, 'thread'); // inferred from thread suffix
});

test('parseEndpoint: legacy [COCO TYPE]/ prefix stripped, type hinted', () => {
  const e = parseEndpoint('[COCO GROUP]/conv-9|reply:m2');
  assert.equal(e.conversationId, 'conv-9');
  assert.equal(e.replyTo, 'm2');
  assert.equal(e.type, 'group');
});

test('parseEndpoint: empty throws', () => {
  assert.throws(() => parseEndpoint(''), /invalid endpoint/);
  assert.throws(() => parseEndpoint('|reply:x'), /invalid endpoint/);
});

test('formatEndpoint: minimal form, type ignored', () => {
  assert.equal(formatEndpoint({ conversationId: 'c1' }), 'c1');
  assert.equal(
    formatEndpoint({ type: 'group', conversationId: 'c1', replyTo: 'm1' }),
    'c1|reply:m1',
  );
  assert.equal(
    formatEndpoint({ conversationId: 'c1', threadConversationId: 't1', parentMessageId: 'p1' }),
    'c1|thread:t1|parent:p1',
  );
});

test('formatEndpoint: round-trips through parseEndpoint', () => {
  const s = 'c1|reply:m1|thread:t1|parent:p1';
  assert.equal(formatEndpoint(parseEndpoint(s)), s);
});

test('formatEndpoint: missing conversationId throws', () => {
  assert.throws(() => formatEndpoint({}), /conversationId required/);
});

test('looksLikeMarkdown: detects common markdown, false for plain text', () => {
  assert.equal(looksLikeMarkdown('# heading'), true);
  assert.equal(looksLikeMarkdown('some **bold** text'), true);
  assert.equal(looksLikeMarkdown('inline `code` here'), true);
  assert.equal(looksLikeMarkdown('a [link](http://x)'), true);
  assert.equal(looksLikeMarkdown('```\ncode\n```'), true);
  assert.equal(looksLikeMarkdown('just plain prose here'), false);
  assert.equal(looksLikeMarkdown(''), false);
  assert.equal(looksLikeMarkdown(null), false);
});

test('parseMediaPrefix: image/file with path and optional caption', () => {
  assert.deepEqual(parseMediaPrefix('[MEDIA:image]/tmp/a.png'), { kind: 'image', localPath: '/tmp/a.png', caption: undefined });
  assert.deepEqual(parseMediaPrefix('[MEDIA:file]/tmp/doc.pdf\nhere you go'), { kind: 'file', localPath: '/tmp/doc.pdf', caption: 'here you go' });
  assert.equal(parseMediaPrefix('no prefix'), null);
});

test('splitMessage: short text returns single chunk', () => {
  assert.deepEqual(splitMessage('hi'), ['hi']);
});

test('splitMessage: splits on paragraph boundary', () => {
  const para = 'A'.repeat(2000) + '\n\n' + 'B'.repeat(2000);
  const chunks = splitMessage(para, 3000);
  assert.ok(chunks.length >= 2);
  for (const c of chunks) assert.ok(c.length <= 3000);
});

test('splitMessage: hard-cuts text with no break points', () => {
  const chunks = splitMessage('X'.repeat(5000), 2000);
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].length, 2000);
});
