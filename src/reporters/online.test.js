import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOnlineReporter } from './online.js';

const apiPath = (p) => `/api/v1${p}`;
const noop = () => {};

function makeReporter({ liveMemberId = '', post } = {}) {
  const calls = [];
  const reporter = createOnlineReporter({
    loadConfig: () => ({ orgs: { 'org-a': { self: { member_id: liveMemberId, name: '' } } } }),
    postForOrg: async (orgId, path) => {
      calls.push({ orgId, path });
      return post ? post() : { triggered: false, reason: 'already_reported' };
    },
    apiPath,
    log: noop,
    warn: noop,
  });
  return { reporter, calls };
}

function org(memberId = '') {
  // Keyed by org_id end to end — loadConfig().orgs is keyed by 'org-a' too.
  return { org_id: 'org-a', self: { member_id: memberId, name: '' } };
}

test('member_id 无处可取时跳过且不标记 done（下次调用仍会重试）', async () => {
  const { reporter, calls } = makeReporter({ liveMemberId: '' });
  const o = org('');
  await reporter(o);
  await reporter(o);
  assert.equal(calls.length, 0);
});

test('捕获对象缺 member_id 时从 live config 补齐并回填（fresh-install 写回场景）', async () => {
  const { reporter, calls } = makeReporter({ liveMemberId: 'm-live' });
  const o = org('');
  await reporter(o);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/api/v1/agents/m-live/online-report');
  assert.equal(o.self.member_id, 'm-live');
});

test('成功后标记 done，再次调用不重发', async () => {
  const { reporter, calls } = makeReporter();
  const o = org('m-1');
  await reporter(o);
  await reporter(o);
  assert.equal(calls.length, 1);
});

test('非 404 失败向上抛且不标记 done，下次调用重试', async () => {
  let attempts = 0;
  const { reporter, calls } = makeReporter({
    post: () => {
      attempts += 1;
      if (attempts === 1) { const e = new Error('boom'); e.status = 500; throw e; }
      return { triggered: true, reason: 'first_agent' };
    },
  });
  const o = org('m-1');
  await assert.rejects(() => reporter(o), /boom/);
  await reporter(o); // retry succeeds
  await reporter(o); // now done — no third POST
  assert.equal(calls.length, 2);
});

test('404 视为端点不存在：吞掉、标记 done、不再重试', async () => {
  const warned = [];
  const reporter = createOnlineReporter({
    loadConfig: () => ({ orgs: {} }),
    postForOrg: async () => { const e = new Error('not found'); e.status = 404; throw e; },
    apiPath,
    log: noop,
    warn: (m) => warned.push(m),
  });
  const o = org('m-1');
  await reporter(o); // must not throw
  await reporter(o);
  assert.equal(warned.length, 1);
  assert.match(warned[0], /404/);
});

test('并发调用只发一次（in-flight 防抖）', async () => {
  let resolvePost;
  const calls = [];
  const reporter = createOnlineReporter({
    loadConfig: () => ({ orgs: {} }),
    postForOrg: (orgId, path) => {
      calls.push(path);
      return new Promise((r) => { resolvePost = r; });
    },
    apiPath,
    log: noop,
    warn: noop,
  });
  const o = org('m-1');
  const p1 = reporter(o);
  const p2 = reporter(o); // in-flight — must not double-post
  resolvePost({ triggered: true });
  await Promise.all([p1, p2]);
  assert.equal(calls.length, 1);
});
