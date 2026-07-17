import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AsService, createAsService } from './as.js';
import { makeClient, ok, clearCwsEnv } from './_fixtures.js';

clearCwsEnv();

test('getMediaUrl POSTs to /artifacts/resolve and unwraps the resolved entry', async () => {
  const uri = 'artifact://abc-123';
  const { http, fetch } = makeClient([ok({
    resolved: { [uri]: { download_url: 'https://cdn/x', expires_at: 't', content_type: 'image/png', content_length: 5, name: 'x.png' } },
    failed: [],
  })]);
  const out = await new AsService(http).getMediaUrl('abc-123');
  assert.equal(fetch.requests[0].method, 'POST');
  assert.equal(fetch.requests[0].path, '/api/v1/artifacts/resolve');
  assert.deepEqual(fetch.requests[0].body, { uris: [uri], inline: false });
  assert.deepEqual(out, { url: 'https://cdn/x', expiresAt: 't', contentType: 'image/png', contentLength: 5, name: 'x.png' });
});

test('getMediaUrl throws when the artifact is not resolvable', async () => {
  const uri = 'artifact://missing';
  const { http } = makeClient([ok({ resolved: {}, failed: [uri] })]);
  await assert.rejects(() => new AsService(http).getMediaUrl('missing'), /not resolvable/);
});

test('resolveUris validates a non-empty array and forwards inline', async () => {
  const { http, fetch } = makeClient([ok({ resolved: {}, failed: [] })]);
  await new AsService(http).resolveUris(['artifact://a', 'artifact://b'], { inline: true });
  assert.deepEqual(fetch.requests[0].body, { uris: ['artifact://a', 'artifact://b'], inline: true });

  const { http: http2 } = makeClient([ok()]);
  await assert.rejects(() => new AsService(http2).resolveUris([]), /non-empty array/);
});

test('uploadMedia (KB mode, instant_upload) prepares + finalizes and returns the tree node', async () => {
  const tmpFile = path.join(os.tmpdir(), `as-test-${Date.now()}.txt`);
  fs.writeFileSync(tmpFile, 'hello');
  try {
    const { http, fetch } = makeClient([
      ok({ upload_token: 'tok', instant_upload: true }),          // /uploads/prepare
      ok({ id: 'node1', artifact_id: 'art1', name: 'f.txt' }),    // /uploads/finalize
    ]);
    const out = await new AsService(http).uploadMedia(tmpFile, { filename: 'f.txt', parentId: 'n0' });
    assert.equal(fetch.requests[0].path, '/api/v1/uploads/prepare');
    assert.equal(fetch.requests[0].body.parent_id, 'n0');
    assert.equal(fetch.requests[0].body.filename, 'f.txt');
    assert.equal(fetch.requests[1].path, '/api/v1/uploads/finalize');
    assert.deepEqual(fetch.requests[1].body, { upload_token: 'tok' });
    assert.equal(out.artifactId, 'art1');
    assert.equal(out.nodeId, 'node1');
    assert.equal(out.instantUpload, true);
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
});

test('uploadMedia (IM mode) PUTs bytes then finalizes to media/artifact ids', async () => {
  const tmpFile = path.join(os.tmpdir(), `as-im-${Date.now()}.png`);
  fs.writeFileSync(tmpFile, 'bytes');
  try {
    const { http, fetch } = makeClient([
      ok({ upload_token: 'tok', upload_url: 'https://up/put', instant_upload: false }), // prepare
      { status: 200, text: '' },                                                        // PUT bytes (raw)
      ok({ media_id: 'm1', artifact_id: 'a1' }),                                         // finalize
    ]);
    const out = await new AsService(http).uploadMedia(tmpFile, { conversationId: 'cv1' });
    assert.equal(fetch.requests[0].path, '/api/v1/conversations/cv1/uploads/prepare');
    assert.equal(fetch.requests[1].method, 'PUT');
    assert.equal(fetch.requests[1].url, 'https://up/put');
    assert.equal(fetch.requests[2].path, '/api/v1/conversations/uploads/finalize');
    assert.equal(out.mediaId, 'm1');
    assert.equal(out.artifactId, 'a1');
    assert.equal(out.mimeType, 'image/png'); // inferred from .png extension
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
});

test('downloadMedia writes bytes to the storage download dir and returns the path', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'as-dl-'));
  try {
    const { http } = makeClient([{ status: 200, text: 'file-bytes' }]); // getBytes(url)
    const as = createAsService(http, { downloadDir: () => dir });
    const localPath = await as.downloadMedia('https://cdn/file.bin', 'out.bin');
    assert.equal(localPath, path.join(dir, 'out.bin'));
    assert.equal(fs.readFileSync(localPath, 'utf8'), 'file-bytes');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('constructor rejects a missing http client', () => {
  assert.throws(() => new AsService(), /requires a CwsHttpClient/);
});
