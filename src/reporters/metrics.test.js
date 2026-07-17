import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMetricsReporter, buildPayload, selectPrimaryOrg } from './metrics.js';

const quiet = { info() {}, warn() {}, error() {} };

// Minimal dashboard-shaped runtime state.
const STATE = {
  system_metrics: {
    cpu_pct: 11, mem_pct: 22, mem_total_bytes: 2000, mem_used_bytes: 1000,
    disk_pct: 33, disk_free_bytes: 5000,
  },
  runtime_info: { model_id: 'm-id', model: 'sonnet', effort: 'high' },
  state: 'RUNNING', context_pct: 44,
  session_cost: 1, daily_cost: 2, weekly_cost: 3,
  rate_limit_pct: 55,
};

const CG_CONTAINER = {
  cgroup_version: 'v2', cpu_pct: 77, mem_pct: 88, mem_total_bytes: 900, mem_used_bytes: 800,
};
const CG_NONE = { cgroup_version: 'none', cpu_pct: null, mem_pct: null, mem_total_bytes: null, mem_used_bytes: null };

const fakeCgroup = (read) => ({ sample() {}, read: () => read });
const runtimeState = (get) => ({ getMetrics: get });

function fakeHttp() {
  const puts = [];
  const http = {
    apiPath: (p) => `/api/v1${p}`,
    putForOrg: async (orgId, path, body) => { puts.push({ orgId, path, body }); return {}; },
  };
  http.puts = puts;
  return http;
}

function orgs(entries) {
  return new Map(entries);
}

// ── buildPayload ────────────────────────────────────────────────────────────

test('buildPayload: containerized → CPU/mem from cgroup, disk from state', () => {
  const p = buildPayload(STATE, CG_CONTAINER, '9.9.9');
  assert.equal(p.version, '9.9.9');
  assert.equal(p.resources.cpu_pct, 77);
  assert.equal(p.resources.mem_pct, 88);
  assert.equal(p.resources.mem_total_bytes, 900);
  assert.equal(p.resources.mem_used_bytes, 800);
  assert.equal(p.resources.disk_pct, 33, 'disk always from runtime state');
  assert.equal(p.resources.disk_free_bytes, 5000);
  assert.equal(p.runtime.state, 'RUNNING');
  assert.equal(p.runtime.model, 'sonnet');
  assert.equal(p.cost.daily, 2);
  assert.equal(p.rate_limit_pct, 55);
});

test('buildPayload: non-containerized (cgroup none) → CPU/mem fall back to runtime state', () => {
  const p = buildPayload(STATE, CG_NONE);
  assert.equal(p.resources.cpu_pct, 11);
  assert.equal(p.resources.mem_pct, 22);
  assert.equal(p.resources.mem_total_bytes, 2000);
  assert.equal(p.resources.mem_used_bytes, 1000);
});

test('buildPayload: null state → null', () => {
  assert.equal(buildPayload(null, CG_NONE), null);
});

// ── selectPrimaryOrg ──────────────────────────────────────────────────────────

test('selectPrimaryOrg: first inserted org is primary', () => {
  const m = orgs([
    ['a', { org_id: 'oa', self: { member_id: 'ma' } }],
    ['b', { org_id: 'ob', self: { member_id: 'mb' } }],
  ]);
  const p = selectPrimaryOrg(m);
  assert.equal(p.slug, 'a');
  assert.equal(p.selfMemberId, 'ma');
});

test('selectPrimaryOrg: empty → null', () => {
  assert.equal(selectPrimaryOrg(orgs([])), null);
});

// ── createMetricsReporter ─────────────────────────────────────────────────────

test('reportMetrics: PUTs the merged payload to the primary org only', async () => {
  const http = fakeHttp();
  const report = createMetricsReporter(
    orgs([['a', { org_id: 'oa', self: { member_id: 'ma' } }]]),
    { http, runtimeState: runtimeState(async () => STATE), cgroup: fakeCgroup(CG_CONTAINER), version: '1.0.0', logger: quiet },
  );
  await report();
  assert.equal(http.puts.length, 1);
  assert.equal(http.puts[0].orgId, 'oa');
  assert.equal(http.puts[0].path, '/api/v1/agents/ma/runtime-metrics');
  assert.equal(http.puts[0].body.resources.cpu_pct, 77);
  assert.equal(http.puts[0].body.version, '1.0.0');
});

test('reportMetrics: null/empty runtime state → skip (no PUT)', async () => {
  const http = fakeHttp();
  const report = createMetricsReporter(
    orgs([['a', { org_id: 'oa', self: { member_id: 'ma' } }]]),
    { http, runtimeState: runtimeState(async () => null), cgroup: fakeCgroup(CG_CONTAINER), logger: quiet },
  );
  await report();
  assert.equal(http.puts.length, 0);
});

test('reportMetrics: getMetrics throws → skip (no PUT, no throw)', async () => {
  const http = fakeHttp();
  const report = createMetricsReporter(
    orgs([['a', { org_id: 'oa', self: { member_id: 'ma' } }]]),
    { http, runtimeState: runtimeState(async () => { throw new Error('down'); }), cgroup: fakeCgroup(CG_NONE), logger: quiet },
  );
  await report(); // must not throw
  assert.equal(http.puts.length, 0);
});

test('reportMetrics: primary org without self.member_id → skip', async () => {
  const http = fakeHttp();
  const warns = [];
  const report = createMetricsReporter(
    orgs([['a', { org_id: 'oa', self: {} }]]),
    { http, runtimeState: runtimeState(async () => STATE), cgroup: fakeCgroup(CG_NONE),
      logger: { info() {}, warn: (m) => warns.push(String(m)), error() {} } },
  );
  await report();
  assert.equal(http.puts.length, 0);
  assert.ok(warns.some((w) => /no self\.member_id/.test(w)));
});

test('reportMetrics: 404 from runtime-metrics endpoint is warned once', async () => {
  const warns = [];
  const http = {
    apiPath: (p) => `/api/v1${p}`,
    putForOrg: async () => { const e = new Error('nope'); e.status = 404; throw e; },
  };
  const report = createMetricsReporter(
    orgs([['a', { org_id: 'oa', self: { member_id: 'ma' } }]]),
    { http, runtimeState: runtimeState(async () => STATE), cgroup: fakeCgroup(CG_NONE),
      logger: { info() {}, warn: (m) => warns.push(String(m)), error() {} } },
  );
  await report();
  await report();
  assert.equal(warns.filter((w) => /404/.test(w)).length, 1, 'endpoint-404 warned exactly once');
});

test('createMetricsReporter: requires http or explicit putForOrg + apiPath', () => {
  assert.throws(() => createMetricsReporter(orgs([]), { logger: quiet }), /requires a CwsHttpClient/);
});
