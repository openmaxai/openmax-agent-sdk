import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { SDK_VERSION } from './index.js';

// `SDK_VERSION` is a hardcoded literal in src/index.js — deliberately NOT a
// runtime `createRequire('../package.json')`, because that call does not survive
// bundling: a consumer inlining the SDK into a self-contained artifact would
// carry the read into their bundle, where `../package.json` fails to resolve at
// runtime. This test is the drift guard — reading package.json here is safe
// because tests run in-repo (package.json present) and are never bundled.
test('SDK_VERSION matches package.json version', () => {
  const pkg = createRequire(import.meta.url)('../package.json');
  assert.equal(SDK_VERSION, pkg.version);
});
