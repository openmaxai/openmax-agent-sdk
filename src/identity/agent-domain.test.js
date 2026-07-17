import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAgentBaseUrl, normalizeBaseUrl } from './agent-domain.js';

// Injected identityId so no config/GET-me round-trip is needed. apiPathFn is
// identity to keep asserted paths readable. No network is ever touched.
const ID = 'id-123';
const apiPathFn = (p) => p;

test('normalizeBaseUrl strips trailing slashes and trims', () => {
  assert.equal(normalizeBaseUrl('https://a.example.com/'), 'https://a.example.com');
  assert.equal(normalizeBaseUrl('  https://a.example.com//  '), 'https://a.example.com');
  assert.equal(normalizeBaseUrl(undefined), '');
});

test('(a) core returns a bound domain → base_url built from full_domain', async () => {
  const calls = [];
  const getFn = async (path) => {
    calls.push(path);
    return { full_domain: 'gavin.agents.coco.xyz', label: 'gavin', root_suffix: 'agents.coco.xyz' };
  };

  const out = await resolveAgentBaseUrl({
    getFn,
    apiPathFn,
    identityId: ID,
    env: {},
  });

  assert.deepEqual(out, {
    ok: true,
    source: 'core',
    full_domain: 'gavin.agents.coco.xyz',
    label: 'gavin',
    root_suffix: 'agents.coco.xyz',
    base_url: 'https://gavin.agents.coco.xyz',
  });
  assert.deepEqual(calls, [`/platform-agents/${ID}/domain`]);
});

test('(b) core 404 + AGENT_PUBLIC_BASE_URL set → base_url from env (normalized)', async () => {
  const getFn = async () => {
    const err = new Error('not found');
    err.status = 404;
    throw err;
  };

  const out = await resolveAgentBaseUrl({
    getFn,
    apiPathFn,
    identityId: ID,
    env: { AGENT_PUBLIC_BASE_URL: 'https://hook.example.com/' },
  });

  assert.deepEqual(out, { ok: true, source: 'env', base_url: 'https://hook.example.com' });
});

test('(c) core 404 + AGENT_PUBLIC_BASE_URL unset → ok:false with error', async () => {
  const getFn = async () => {
    const err = new Error('not found');
    err.status = 404;
    throw err;
  };

  const out = await resolveAgentBaseUrl({
    getFn,
    apiPathFn,
    identityId: ID,
    env: {},
  });

  assert.deepEqual(out, {
    ok: false,
    error: 'no bound domain and AGENT_PUBLIC_BASE_URL unset',
  });
});

test('non-404 core error propagates (not swallowed into env fallback)', async () => {
  const getFn = async () => {
    const err = new Error('boom');
    err.status = 500;
    throw err;
  };

  await assert.rejects(
    () => resolveAgentBaseUrl({ getFn, apiPathFn, identityId: ID, env: { AGENT_PUBLIC_BASE_URL: 'https://x.example.com' } }),
    /boom/,
  );
});

test('core 200 without full_domain throws (protocol violation, no env fallback)', async () => {
  const getFn = async () => ({});
  await assert.rejects(
    () => resolveAgentBaseUrl({
      getFn,
      apiPathFn,
      identityId: ID,
      env: { AGENT_PUBLIC_BASE_URL: 'https://fallback.example.com' },
    }),
    /protocol violation.*no full_domain/,
  );
});

test('GET /me 200 without identity_id throws (protocol violation, no env fallback)', async () => {
  const getFn = async (path) => {
    if (path === '/me') return { some: 'thing' }; // 200 but no identity_id
    throw new Error('domain endpoint must not be reached');
  };

  await assert.rejects(
    () => resolveAgentBaseUrl({
      getFn,
      apiPathFn,
      config: { agent: {} },
      env: { AGENT_PUBLIC_BASE_URL: 'https://fallback.example.com' },
    }),
    /protocol violation.*no identity_id/,
  );
});

test('identity_id resolved from injected config when not passed directly', async () => {
  const calls = [];
  const getFn = async (path) => {
    calls.push(path);
    return { full_domain: 'a.b.c' };
  };

  const out = await resolveAgentBaseUrl({
    getFn,
    apiPathFn,
    config: { agent: { identity_id: 'cfg-id' } },
    env: {},
  });

  assert.equal(out.source, 'core');
  assert.equal(out.base_url, 'https://a.b.c');
  // Only the domain lookup is called — no /me round-trip since config had the id.
  assert.deepEqual(calls, ['/platform-agents/cfg-id/domain']);
});

test('identity_id falls back to GET /me when config lacks it', async () => {
  const calls = [];
  const getFn = async (path) => {
    calls.push(path);
    if (path === '/me') return { identity_id: 'me-id' };
    return { full_domain: 'd.e.f' };
  };

  const out = await resolveAgentBaseUrl({
    getFn,
    apiPathFn,
    config: { agent: {} },
    env: {},
  });

  assert.equal(out.base_url, 'https://d.e.f');
  assert.deepEqual(calls, ['/me', '/platform-agents/me-id/domain']);
});
