import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isSiblingAgentSender,
  extractMentions,
  isSelfNameMentionedInText,
  decideInbound,
  noticeDmNotAllowed,
  VALID_DM_POLICIES,
  VALID_GROUP_MODES,
  VALID_GROUP_SCOPES,
} from './access-policy.js';

// ── isSiblingAgentSender (ported from zylos-openmax dm-access.test.js) ────────

test('isSiblingAgentSender: 同 owner 的 agent 发件人命中', () => {
  assert.equal(
    isSiblingAgentSender({ senderType: 'AGENT', senderOwnerId: 'owner-1', selfOwnerId: 'owner-1' }),
    true,
  );
});

test('isSiblingAgentSender: sender_type 大小写不敏感', () => {
  assert.equal(
    isSiblingAgentSender({ senderType: 'agent', senderOwnerId: 'owner-1', selfOwnerId: 'owner-1' }),
    true,
  );
});

test('isSiblingAgentSender: owner 不同不命中', () => {
  assert.equal(
    isSiblingAgentSender({ senderType: 'AGENT', senderOwnerId: 'owner-2', selfOwnerId: 'owner-1' }),
    false,
  );
});

test('isSiblingAgentSender: 人类发件人不命中（即便恰好共享 id）', () => {
  assert.equal(
    isSiblingAgentSender({ senderType: 'HUMAN', senderOwnerId: 'owner-1', selfOwnerId: 'owner-1' }),
    false,
  );
});

test('isSiblingAgentSender: 自身无 owner（未绑定）不命中', () => {
  assert.equal(
    isSiblingAgentSender({ senderType: 'AGENT', senderOwnerId: 'owner-1', selfOwnerId: '' }),
    false,
  );
});

test('isSiblingAgentSender: 发件人 owner 未知不命中', () => {
  assert.equal(
    isSiblingAgentSender({ senderType: 'AGENT', senderOwnerId: '', selfOwnerId: 'owner-1' }),
    false,
  );
});

test('isSiblingAgentSender: 缺省入参安全返回 false', () => {
  assert.equal(isSiblingAgentSender(), false);
  assert.equal(isSiblingAgentSender({}), false);
});

// ── pure helpers ─────────────────────────────────────────────────────────────

test('extractMentions: structured / string / id fallbacks', () => {
  assert.deepEqual(extractMentions({ mentions: [{ entity_id: 'm1' }, 'm2', { id: 'm3' }] }), ['m1', 'm2', 'm3']);
  assert.deepEqual(extractMentions({ content: { mention_user_ids: ['x'] } }), ['x']);
  assert.deepEqual(extractMentions({}), []);
});

test('isSelfNameMentionedInText: @name with word-boundary guard', () => {
  assert.equal(isSelfNameMentionedInText({ content: { body: { text: 'hey @Zylos help' } } }, 'Zylos'), true);
  assert.equal(isSelfNameMentionedInText({ content: { body: { text: 'ping @Zylos-GavinBox' } } }, 'Zylos'), false);
  assert.equal(isSelfNameMentionedInText({ content: { body: { text: 'nothing here' } } }, 'Zylos'), false);
  assert.equal(isSelfNameMentionedInText({ content: { body: { text: 'x' } } }, ''), false);
});

test('schema sets are exported and correct', () => {
  assert.ok(VALID_DM_POLICIES.has('owner') && VALID_DM_POLICIES.has('open') && VALID_DM_POLICIES.has('allowlist'));
  assert.ok(VALID_GROUP_MODES.has('smart') && VALID_GROUP_MODES.has('mention') && VALID_GROUP_MODES.has('silent'));
  assert.ok(VALID_GROUP_SCOPES.has('disabled'));
});

// ── decideInbound: DM branches ───────────────────────────────────────────────

const dmConv = { type: 'dm' };

test('decideInbound: self-echo dropped', async () => {
  const d = await decideInbound(
    { sender_id: 'me', conversation_id: 'c' }, dmConv,
    { self: { member_id: 'me' } },
  );
  assert.equal(d.handle, false);
  assert.equal(d.reason, 'self-echo');
});

test('decideInbound: SYSTEM sender bypasses all gates, no notice', async () => {
  const d = await decideInbound(
    { sender_type: 'SYSTEM', sender_id: 'sys', conversation_id: 'c' }, dmConv,
    { self: { member_id: 'me' }, access: { dmPolicy: 'owner' } },
  );
  assert.equal(d.handle, true);
  assert.equal(d.reason, 'system-sender');
  assert.equal(d.userNotice, undefined);
});

test('decideInbound: bound owner always allowed + ownerNameHint when name missing', async () => {
  const d = await decideInbound(
    { sender_id: 'owner-1', sender_display_name: 'Alice', conversation_id: 'c' }, dmConv,
    { self: { member_id: 'me' }, owner: { member_id: 'owner-1' }, access: { dmPolicy: 'allowlist' } },
  );
  assert.equal(d.handle, true);
  assert.equal(d.reason, 'dm:owner-exempt');
  assert.equal(d.ownerNameHint, 'Alice');
});

test('decideInbound: owner name already set → no hint (no mutation)', async () => {
  const orgConfig = { self: { member_id: 'me' }, owner: { member_id: 'owner-1', name: 'Alice' }, access: {} };
  const d = await decideInbound(
    { sender_id: 'owner-1', sender_display_name: 'Alice2', conversation_id: 'c' }, dmConv, orgConfig,
  );
  assert.equal(d.ownerNameHint, undefined);
  assert.equal(orgConfig.owner.name, 'Alice'); // engine did not mutate config
});

test('decideInbound: dmPolicy open lets anyone through', async () => {
  const d = await decideInbound(
    { sender_id: 'x', conversation_id: 'c' }, dmConv,
    { self: { member_id: 'me' }, access: { dmPolicy: 'open' } },
  );
  assert.equal(d.handle, true);
  assert.equal(d.reason, 'dm:open');
});

test('decideInbound: sibling-agent exemption uses injected fetchMemberOwner', async () => {
  const calls = [];
  const d = await decideInbound(
    { sender_id: 'agent-2', sender_type: 'AGENT', conversation_id: 'c' }, dmConv,
    { self: { member_id: 'me' }, owner: { member_id: 'owner-1' }, org_id: 'org-1', access: { dmPolicy: 'owner' } },
    { fetchMemberOwner: async (orgId, memberId) => { calls.push([orgId, memberId]); return 'owner-1'; } },
  );
  assert.equal(d.handle, true);
  assert.equal(d.reason, 'dm:sibling-agent');
  assert.deepEqual(calls, [['org-1', 'agent-2']]);
});

test('decideInbound: default fetchMemberOwner (null) → sibling exemption never fires', async () => {
  const d = await decideInbound(
    { sender_id: 'agent-2', sender_type: 'AGENT', conversation_id: 'c' }, dmConv,
    { self: { member_id: 'me' }, owner: { member_id: 'owner-1', name: 'Alice' }, org_id: 'org-1', access: { dmPolicy: 'owner' } },
  );
  assert.equal(d.handle, false); // falls through to owner-policy reject
});

test('decideInbound: allowlist hit / miss (miss carries userNotice)', async () => {
  const org = { self: { member_id: 'me' }, owner: { name: 'Alice' }, access: { dmPolicy: 'allowlist', dmAllowFrom: ['ok'] } };
  const hit = await decideInbound({ sender_id: 'ok', conversation_id: 'c' }, dmConv, org);
  assert.equal(hit.handle, true);
  const miss = await decideInbound({ sender_id: 'nope', conversation_id: 'c' }, dmConv, org);
  assert.equal(miss.handle, false);
  assert.equal(miss.userNotice, noticeDmNotAllowed('Alice'));
});

test('decideInbound: owner-policy first DM auto-binds', async () => {
  const d = await decideInbound(
    { sender_id: 'new', sender_display_name: 'Bob', conversation_id: 'c' }, dmConv,
    { self: { member_id: 'me' }, access: { dmPolicy: 'owner' } },
  );
  assert.equal(d.handle, true);
  assert.deepEqual(d.bindOwnerHint, { memberId: 'new', displayName: 'Bob' });
});

test('decideInbound: owner-policy rejects non-owner once bound', async () => {
  const d = await decideInbound(
    { sender_id: 'stranger', conversation_id: 'c' }, dmConv,
    { self: { member_id: 'me' }, owner: { member_id: 'owner-1', name: 'Alice' }, access: { dmPolicy: 'owner' } },
  );
  assert.equal(d.handle, false);
  assert.ok(d.userNotice);
});

// ── decideInbound: group branches ────────────────────────────────────────────

test('decideInbound: group disabled — notice only when mentioned', async () => {
  const org = { self: { member_id: 'me', display_name: 'Zy' }, access: { groupPolicy: 'disabled' } };
  const silent = await decideInbound({ sender_id: 'u', conversation_id: 'g' }, { type: 'group' }, org);
  assert.equal(silent.handle, false);
  assert.equal(silent.userNotice, undefined);
  const noticed = await decideInbound(
    { sender_id: 'u', conversation_id: 'g', content: { body: { text: '@Zy hi' } } }, { type: 'group' }, org,
  );
  assert.equal(noticed.handle, false);
  assert.ok(noticed.userNotice);
});

test('decideInbound: group allowlist — unknown group dropped unless owner @-mention', async () => {
  const org = { self: { member_id: 'me', display_name: 'Zy' }, owner: { member_id: 'owner-1' }, access: { groupPolicy: 'allowlist', groups: {} } };
  const dropped = await decideInbound({ sender_id: 'u', conversation_id: 'g' }, { type: 'group' }, org);
  assert.equal(dropped.handle, false);
  const ownerBypass = await decideInbound(
    { sender_id: 'owner-1', conversation_id: 'g', content: { body: { text: '@Zy help' } } }, { type: 'group' }, org,
  );
  assert.equal(ownerBypass.handle, true);
  assert.ok(ownerBypass.reason.includes('owner-mention-bypass'));
});

test('decideInbound: group mention mode requires @', async () => {
  const org = { self: { member_id: 'me', display_name: 'Zy' }, access: { groupPolicy: 'allowlist', groups: { g: { mode: 'mention', allowFrom: ['*'] } } } };
  const notMentioned = await decideInbound({ sender_id: 'u', conversation_id: 'g' }, { type: 'group' }, org);
  assert.equal(notMentioned.handle, false);
  assert.equal(notMentioned.reason, 'group:mention (not @-ed)');
  const mentioned = await decideInbound(
    { sender_id: 'u', conversation_id: 'g', content: { body: { text: '@Zy yo' } } }, { type: 'group' }, org,
  );
  assert.equal(mentioned.handle, true);
});

test('decideInbound: group smart mode bypasses mention requirement', async () => {
  const org = { self: { member_id: 'me', display_name: 'Zy' }, access: { groupPolicy: 'allowlist', groups: { g: { mode: 'smart', allowFrom: ['*'] } } } };
  const d = await decideInbound({ sender_id: 'u', conversation_id: 'g' }, { type: 'group' }, org);
  assert.equal(d.handle, true);
  assert.equal(d.mode, 'smart');
});

test('decideInbound: group allowFrom restriction (notice only when mentioned)', async () => {
  const org = { self: { member_id: 'me', display_name: 'Zy' }, access: { groupPolicy: 'allowlist', groups: { g: { mode: 'smart', allowFrom: ['vip'] } } } };
  const blocked = await decideInbound({ sender_id: 'rando', conversation_id: 'g' }, { type: 'group' }, org);
  assert.equal(blocked.handle, false);
  assert.equal(blocked.userNotice, undefined); // not mentioned → silent
});
