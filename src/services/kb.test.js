import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KbService, createKbService } from './kb.js';
import { makeClient, ok, clearCwsEnv } from './_fixtures.js';

clearCwsEnv();

test('list forwards limit/offset', async () => {
  const { http, fetch } = makeClient([ok([])]);
  await new KbService(http).list({ limit: 10, offset: 5 });
  assert.equal(fetch.requests[0].path, '/api/v1/kbs');
  assert.equal(fetch.requests[0].query.limit, '10');
  assert.equal(fetch.requests[0].query.offset, '5');
});

test('create defaults visibility to closed', async () => {
  const { http, fetch } = makeClient([ok({ id: 'kb1' })]);
  const out = await new KbService(http).create({ name: 'Docs' });
  assert.equal(fetch.requests[0].method, 'POST');
  assert.equal(fetch.requests[0].path, '/api/v1/kbs');
  assert.deepEqual(fetch.requests[0].body, { name: 'Docs', visibility: 'closed' });
  assert.deepEqual(out, { id: 'kb1' });
});

test('kbId is required for kb-scoped commands', async () => {
  const { http } = makeClient([ok()]);
  assert.throws(() => new KbService(http).get({}), /kbId is required/);
});

test('pageCreate uses kb-scoped path and accepts parentNodeId alias', async () => {
  const { http, fetch } = makeClient([ok()]);
  await new KbService(http).pageCreate({ kbId: 'kb1', title: 'T', body: 'hi', parentNodeId: 'n9' });
  assert.equal(fetch.requests[0].path, '/api/v1/kbs/kb1/pages');
  assert.deepEqual(fetch.requests[0].body, { title: 'T', format: 'markdown', body: 'hi', parent_id: 'n9' });
});

test('pageDiff sends from_revision/to_revision without the _id suffix', async () => {
  const { http, fetch } = makeClient([ok()]);
  await new KbService(http).pageDiff({ pageId: 'p1', fromRevisionId: 'r1', toRevisionId: 'r2' });
  assert.equal(fetch.requests[0].path, '/api/v1/pages/p1/revisions/diff');
  assert.equal(fetch.requests[0].query.from_revision, 'r1');
  assert.equal(fetch.requests[0].query.to_revision, 'r2');
  assert.equal(fetch.requests[0].searchParams.has('from_revision_id'), false);
});

test('pageContentWrite PUTs content with auto_save default false', async () => {
  const { http, fetch } = makeClient([ok()]);
  await new KbService(http).pageContentWrite({ pageId: 'p1', body: 'x' });
  assert.equal(fetch.requests[0].method, 'PUT');
  assert.equal(fetch.requests[0].path, '/api/v1/pages/p1/content');
  assert.deepEqual(fetch.requests[0].body, { body: 'x', auto_save: false });
});

test('search maps query/q + kbId', async () => {
  const { http, fetch } = makeClient([ok([])]);
  await new KbService(http).search({ q: 'weekly notes', kbId: 'kb1', limit: 10 });
  assert.equal(fetch.requests[0].path, '/api/v1/search/pages');
  assert.equal(fetch.requests[0].query.query, 'weekly notes');
  assert.equal(fetch.requests[0].query.kb_id, 'kb1');
});

test('upload delegates to the injected AsService (KB-mode opts)', async () => {
  const { http } = makeClient([ok()]);
  const calls = [];
  const fakeAs = { uploadMedia: async (path, opts) => { calls.push({ path, opts }); return { artifactId: 'a1' }; } };
  const kb = createKbService(http, fakeAs);
  const out = await kb.upload({ filePath: '/tmp/f.png', parentId: 'n1', contentType: 'image/png', filename: 'f.png' });
  assert.deepEqual(out, { artifactId: 'a1' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/tmp/f.png');
  assert.deepEqual(calls[0].opts, { parentId: 'n1', mimeType: 'image/png', filename: 'f.png' });
});

test('upload requires filePath', async () => {
  const { http } = makeClient([ok()]);
  await assert.rejects(() => new KbService(http).upload({}), /filePath is required/);
});
