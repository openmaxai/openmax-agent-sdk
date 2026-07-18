import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSelfNameHydrator } from './self-name-hydration.js';

const noop = () => {};

function org(selfOverrides = {}) {
  return {
    // Keyed by org_id end to end — loadConfig().orgs is keyed by 'org-a' too.
    org_id: 'org-a',
    self: { member_id: 'm-self', name: 'OldName', display_name: '', ...selfOverrides },
  };
}

function makeHydrator({ token, sync, liveMemberId = '', maxAttempts = 3 } = {}) {
  const trace = [];   // 依赖调用顺序
  const warns = [];
  const sleeps = [];
  const hydrate = createSelfNameHydrator({
    acquireToken: async (o) => { trace.push('token'); if (token) await token(o); },
    syncSelf: async (o) => { trace.push('sync'); return sync(o); },
    loadConfig: () => ({ orgs: { 'org-a': { self: { member_id: liveMemberId, name: '' } } } }),
    log: noop,
    warn: (m) => warns.push(String(m)),
    sleep: async (ms) => { sleeps.push(ms); },
    maxAttempts,
    retryDelayMs: 10,
  });
  return { hydrate, trace, warns, sleeps };
}

// 镜像 comm-bridge isSelfNameMentionedInText 的纯文本 @ 检测(cws-comm 原生消息
// 没有结构化 mentions[],只能靠文本匹配)——回归测试用。
function mentionedInText(msg, selfName) {
  if (!selfName) return false;
  const text = msg.content?.body?.text || '';
  const escaped = selfName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('@' + escaped + '(?![\\w-])', 'i').test(text);
}

test('成功路径:token → sync 顺序执行,display_name 在返回前已写入 orgConfig', async () => {
  const { hydrate, trace } = makeHydrator({
    sync: (o) => {
      o.self = { ...o.self, display_name: 'Zylos Prime' };
      return { nameReady: true };
    },
  });
  const o = org();
  const res = await hydrate(o);
  assert.deepEqual(res, { ready: true, source: 'core', displayName: 'Zylos Prime' });
  assert.deepEqual(trace, ['token', 'sync']);
  assert.equal(o.self.display_name, 'Zylos Prime');
});

test('就绪具有粘性:同 org 第二次调用不再发起任何请求(重连快路径)', async () => {
  const { hydrate, trace } = makeHydrator({
    sync: (o) => { o.self = { ...o.self, display_name: 'Zylos Prime' }; return { nameReady: true }; },
  });
  const o = org();
  await hydrate(o);
  const res2 = await hydrate(o);
  assert.equal(res2.ready, true);
  assert.equal(res2.source, 'already');
  assert.equal(res2.displayName, 'Zylos Prime');
  assert.deepEqual(trace, ['token', 'sync']); // 无第二轮 token/sync
});

test('eager-token 失败后恢复:首轮 JWT 失败→未就绪,重试轮 JWT 成功→就绪', async () => {
  let tokenCalls = 0;
  let tokenOk = false;
  const { hydrate, sleeps } = makeHydrator({
    token: async () => {
      tokenCalls += 1;
      if (tokenCalls === 1) throw new Error('exchange failed');
      tokenOk = true;
    },
    sync: (o) => {
      if (!tokenOk) return { nameReady: false, reason: 'no token' };
      o.self = { ...o.self, display_name: 'Zylos Prime' };
      return { nameReady: true };
    },
  });
  const res = await hydrate(org());
  assert.equal(res.ready, true);
  assert.equal(res.source, 'core');
  assert.equal(tokenCalls, 2);
  assert.deepEqual(sleeps, [10]); // 一次退避后恢复
});

test('self-member 读取持续失败且无缓存:有界重试(指数退避)后 fail-open,不抛不挂起', async () => {
  const { hydrate, trace, warns, sleeps } = makeHydrator({
    sync: () => ({ nameReady: false, reason: 'fetch self member failed: 500' }),
  });
  const res = await hydrate(org());
  assert.deepEqual(res, { ready: false, source: 'none', displayName: '' });
  assert.equal(trace.filter((t) => t === 'sync').length, 3); // 恰好 maxAttempts 次
  assert.deepEqual(sleeps, [10, 20]);                        // 有界指数退避
  assert.ok(warns.some((w) => /SELF-NAME NOT HYDRATED/.test(w)), '必须大声记录降级');
});

test('self-member 读取失败但存在持久化的 last-known display_name:以缓存放行', async () => {
  const { hydrate, warns } = makeHydrator({
    sync: () => ({ nameReady: false, reason: 'fetch self member failed: timeout' }),
  });
  const res = await hydrate(org({ display_name: 'Zylos Prime' }));
  assert.deepEqual(res, { ready: true, source: 'cache', displayName: 'Zylos Prime' });
  assert.ok(warns.some((w) => /cached last-known display_name/.test(w)));
});

test('syncSelf 抛异常按未就绪处理并重试,不向上抛', async () => {
  let calls = 0;
  const { hydrate } = makeHydrator({
    sync: (o) => {
      calls += 1;
      if (calls < 2) throw new Error('boom');
      o.self = { ...o.self, display_name: 'Zylos Prime' };
      return { nameReady: true };
    },
  });
  const res = await hydrate(org());
  assert.equal(res.ready, true);
  assert.equal(calls, 2);
});

test('member_id 缺失时从 live config 回填(fresh-install token 写回场景)', async () => {
  let seenMemberId = null;
  const { hydrate } = makeHydrator({
    liveMemberId: 'm-live',
    sync: (o) => {
      seenMemberId = o.self?.member_id;
      o.self = { ...o.self, display_name: 'Zylos Prime' };
      return { nameReady: true };
    },
  });
  const o = org({ member_id: '' });
  const res = await hydrate(o);
  assert.equal(res.ready, true);
  assert.equal(seenMemberId, 'm-live'); // sync 执行时 member_id 已回填
  assert.equal(o.self.member_id, 'm-live');
});

test('urlProvider 单次尝试模式(maxAttempts:1):失败不退避、立即放行,下次重连再试', async () => {
  const { hydrate, trace, sleeps } = makeHydrator({
    sync: () => ({ nameReady: false, reason: 'still down' }),
  });
  const o = org();
  const res = await hydrate(o, { maxAttempts: 1 });
  assert.equal(res.ready, false);
  assert.equal(trace.filter((t) => t === 'sync').length, 1);
  assert.deepEqual(sleeps, []);
  // 下一次重连的 urlProvider 会再试(未 synced 时不走 already 快路径)
  await hydrate(o, { maxAttempts: 1 });
  assert.equal(trace.filter((t) => t === 'sync').length, 2);
});

// 回归:P1 事故路径。启动/重连时 self.name 已漂移(旧值)、display_name 无缓存,
// 连接一建立就 replay 一条纯文本 "@<core display_name>" 帧。屏障必须保证 replay
// 处理时 orgConfig 已持有权威 display_name,首连即命中 @。
test('回归:首连 replay 帧在 hydration 屏障之后处理,@权威 display_name 首连即命中', async () => {
  const o = org({ name: 'Zybot', display_name: '' }); // 手配名已漂移,核心名是 "Zylos Prime"
  const replayFrame = { content: { body: { text: '@Zylos Prime 帮我看下这个任务' } } };

  // 事故前提自检:仅凭漂移的 self.name,这条 @ 会被丢弃
  const staleNames = [o.self.display_name, o.self.name].filter(Boolean);
  assert.equal(staleNames.some((n) => mentionedInText(replayFrame, n)), false);

  const { hydrate } = makeHydrator({
    sync: (oc) => { oc.self = { ...oc.self, display_name: 'Zylos Prime' }; return { nameReady: true }; },
  });

  // 模拟 startOrgWs 结构:hydration 屏障(bootstrap / urlProvider)先于 socket
  // 创建被 await,onOpen replay 只能发生在其之后。
  const handledFrames = [];
  const startWsAndReplay = () => {
    const selfNames = [o.self?.display_name, o.self?.name].filter(Boolean);
    handledFrames.push({
      displayNameAtDispatch: o.self?.display_name || '',
      mentioned: selfNames.some((n) => mentionedInText(replayFrame, n)),
    });
  };

  const res = await hydrate(o);   // 屏障:先于 WS 创建完成
  startWsAndReplay();             // 连接建立,立即 replay 首帧

  assert.equal(res.ready, true);
  assert.equal(handledFrames.length, 1);
  assert.equal(handledFrames[0].displayNameAtDispatch, 'Zylos Prime'); // replay 时权威名已就位
  assert.equal(handledFrames[0].mentioned, true);                      // 首连即命中 @,不再被丢
});
