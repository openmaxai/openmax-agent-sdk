/**
 * CwsAgentBridge — the protocol orchestrator.
 *
 * This is the crux integration module: it wires together every already-extracted
 * SDK piece (transport / protocol / sync / reporters / identity) into a single
 * instantiable class so a runtime adapter can `new CwsAgentBridge(...)` +
 * providers and get a working cws-comm agent. It is the runtime-agnostic
 * distillation of zylos-openmax `src/comm-bridge.js` — the per-org WS lifecycle
 * (`startOrgWs`), the frame dispatch, the sync/ledger wiring, and the
 * PROTOCOL-GENERIC half of `makeOrgMessageHandler`. It reimplements none of the
 * extracted modules; it only composes them and preserves the source's wiring
 * ORDER (authorize/ledger/sync/report), which several invariants depend on.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE INTEGRATION SURFACE — what the ADAPTER must supply
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The one required "translation point" is `providers.inbound` (InboundDelivery):
 *
 *     interface InboundDelivery {
 *       deliver(msg: InboundMessage, endpoint: string, priority?: 1|2|3)
 *         : Promise<{ ok: boolean, runtimeSession?, failureClass?, retryAfterMs? }>
 *     }
 *
 * The orchestrator hands `deliver()` a fully NORMALIZED inbound message (see the
 * `InboundMessage` shape built in `#buildInbound`) AFTER dedupe → detail-fetch →
 * field-hoist → conversation-fetch → access-policy. `deliver()` is where the
 * adapter does its runtime bridging:
 *   - zylos-openmax (Cat.A): `execFile c4-receive.js` (the old `forwardToC4`)
 *   - bare runtime  (Cat.B): `POST /wake` (raft-channel-wake.v1)
 * INVARIANT: `ok:true` MUST mean the message genuinely entered the runtime's
 * visible context — never ack before real delivery, or the ledger/`/sync`
 * retry compensation stops and the message is silently lost.
 *
 * The adapter STILL OWNS everything below the cut line (NONE of it is in the SDK):
 *   - C4 forwarding + `formatInboundForC4` (the XML envelope) + work-reference
 *     formatting — all behind `InboundDelivery.deliver`.
 *   - Media download/upload, group-history/context assembly, quoted-message
 *     expansion, receive-reactions, typing indicators — the adapter reads
 *     `InboundMessage.message` (the full merged raw frame+detail) and does these.
 *   - config.json PERSISTENCE. The SDK classifies `agent.config.*` frames and
 *     hands them to `callbacks.onConfigEvent`; it does NOT write config.
 *   - recall/edit NOTICE TEXT + delivery. The SDK gates them by access policy and
 *     hands them to `callbacks.onSystemNotice`; the adapter formats + delivers.
 *   - connection.* credential lifecycle (`callbacks.onConnectionEvent`) and
 *     channel.* install/liveness (`callbacks.onChannelEvent`) — pm2 + `zylos`
 *     CLI + Caddy live entirely in the adapter (owner decision 2026-07-17).
 *   - auto-upgrade, the argv CLI shells, dashboard/api-key provisioning, and the
 *     channel-liveness reporter — none of these are the SDK's concern.
 *   - session cursor + inbox-ledger + dedup + token persistence to real paths —
 *     supplied via the StorageProvider and the `loadSession`/`saveSession`
 *     callbacks (the SDK never touches `~/zylos`).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CONSTRUCTOR
 * ─────────────────────────────────────────────────────────────────────────────
 *   new CwsAgentBridge({
 *     http,                 // required: CwsHttpClient (transport/http.js)
 *     tokenManager,         // TokenManager (transport/token.js) — mints ws-tickets
 *     ws: {                 // WS options (transport/ws.js)
 *       baseUrl, reconnectMaxMs, heartbeatIntervalMs, pingIntervalMs,
 *       deviceId, clientVersion, cfAccess, wsFactory, urlProvider,
 *     },
 *     orgConfigs: [ { slug, org_id, org_name?, self, owner, access } ],
 *     providers: { storage, runtimeState, inbound, logger },   // resolveProviders()
 *     callbacks: {          // adapter seams — all optional
 *       loadSession, saveSession,       // per-org sync cursor persistence
 *       loadConfig, syncSelf,           // self-name hydration barrier inputs
 *       fetchMemberOwner,               // sibling-agent DM exemption lookup
 *       onOwnerBind, onOwnerNameHint,   // owner auto-bind / name hints → config
 *       onConfigEvent,                  // agent.config.* → adapter persists
 *       onSystemNotice,                 // recall / edit (policy-gated) → adapter
 *       onConnectionEvent, onChannelEvent,  // connection.* / channel.* → adapter
 *       onOrgTerminated, onAllOrgsTerminated,  // 4002/4005/4006 fatal closes
 *       onFrameType,                    // observability hook per frame
 *     },
 *     reporters: { metrics, metricsIntervalMs, metricsInitialDelayMs, version },
 *   })
 *
 * Methods: `start(): Promise<void>` · `stop(): Promise<void>` ·
 *          `send(endpoint, content, opts?)` (outbound helper) ·
 *          `injectFrame(slug, frame)` (drive a frame through an org's pipeline —
 *          used by tests and manual replay).
 */

import { WsClient, createDeduper } from './transport/ws.js';
import { createInboxLedger } from './sync/inbox-ledger.js';
import { SyncEngine } from './sync/sync-engine.js';
import { createFrameDispatcher } from './protocol/frame-dispatch.js';
import { decideInbound } from './protocol/access-policy.js';
import { formatEndpoint, parseEndpoint, newClientMsgId } from './protocol/message-codec.js';
import { systemEventPriority } from './protocol/system-message.js';
import { createSelfNameHydrator } from './identity/self-name-hydration.js';
import { createOnlineReporter } from './reporters/online.js';
import { createMetricsReporter } from './reporters/metrics.js';
import { resolveProviders } from './providers.js';

const DEFAULT_WS_RECONNECT_MAX_MS = 30 * 1000;
const DEFAULT_WS_HEARTBEAT_MS = 30 * 1000;
const DEFAULT_WS_PING_INTERVAL_MS = 20 * 1000;
const DEFAULT_DEDUP_MAX_ENTRIES = 3000;
const DEFAULT_METRICS_INTERVAL_MS = 60 * 1000;
const FRAME_METRIC_INTERVAL_MS = 5 * 60 * 1000;
const MEMBER_OWNER_TTL_MS = 300_000;

export class CwsAgentBridge {
  constructor({
    http,
    tokenManager = null,
    ws = {},
    orgConfigs = [],
    providers = {},
    callbacks = {},
    reporters = {},
  } = {}) {
    if (!http) throw new Error('CwsAgentBridge requires an http (CwsHttpClient)');

    this.http = http;
    this.tokenManager = tokenManager;
    this.providers = resolveProviders(providers);
    this.logger = this.providers.logger;
    this.callbacks = callbacks || {};
    this.orgConfigs = Array.isArray(orgConfigs) ? orgConfigs : [];

    this.wsOpts = {
      baseUrl: (ws.baseUrl || ws.wsUrl || '').replace(/\?.*$/, ''),
      reconnectMaxMs: ws.reconnectMaxMs ?? DEFAULT_WS_RECONNECT_MAX_MS,
      heartbeatIntervalMs: ws.heartbeatIntervalMs ?? DEFAULT_WS_HEARTBEAT_MS,
      pingIntervalMs: ws.pingIntervalMs ?? DEFAULT_WS_PING_INTERVAL_MS,
      deviceId: ws.deviceId || '',
      clientVersion: ws.clientVersion || '',
      cfAccess: ws.cfAccess,
      wsFactory: ws.wsFactory,
      urlProvider: ws.urlProvider || null,
    };

    this.reporterOpts = {
      metricsEnabled: reporters.metrics !== false,
      metricsIntervalMs: reporters.metricsIntervalMs ?? DEFAULT_METRICS_INTERVAL_MS,
      metricsInitialDelayMs: reporters.metricsInitialDelayMs ?? 0,
      version: reporters.version || '0.0.0',
      frameMetrics: reporters.frameMetrics !== false,
      markReadOnDeliver: reporters.markReadOnDeliver !== false,
    };

    // ── shared process-wide state ────────────────────────────────────────────
    // One message-id deduper for the whole process (mirrors comm-bridge's single
    // module-level `dedupe`). Persistence, if any, is the adapter's concern; the
    // default is in-memory count-based retention.
    this._dedupe = this.callbacks.dedupe || createDeduper({
      maxEntries: reporters.dedupMaxEntries ?? DEFAULT_DEDUP_MAX_ENTRIES,
    });

    // slug → per-org runtime record ({ orgConfig, sessionRef, ledger, sync, ws,
    //   onFrame, handleIncomingMessage })
    this._orgs = new Map();
    this._liveOrgCount = 0;

    // process-wide interval timers (metrics, frame-metrics) — armed in start().
    this._timers = [];
    this._started = false;

    // conversation + member-owner caches (protocol-adjacent read optimizations,
    // ported from comm-bridge; short-TTL for owner, unbounded for conversations
    // within the process, exactly as the source).
    this._convCache = new Map();
    this._memberOwnerCache = new Map();
    this._frameCounts = Object.create(null);

    // online reporter (once per process per org; fired on each WS open).
    this._reportAgentOnline = createOnlineReporter({
      http: this.http,
      loadConfig: this.callbacks.loadConfig || (() => ({})),
      log: (...a) => this.logger.info?.(...a),
      warn: (...a) => this.logger.warn?.(...a),
    });

    // self display_name hydration barrier (see identity/self-name-hydration.js).
    this._hydrateSelfName = createSelfNameHydrator({
      acquireToken: async (orgConfig) => {
        if (this.tokenManager) await this.tokenManager.getAccessToken(orgConfig.org_id);
      },
      syncSelf: this.callbacks.syncSelf
        || (async () => ({ nameReady: false, reason: 'no syncSelf callback supplied' })),
      loadConfig: this.callbacks.loadConfig || (() => ({ orgs: {} })),
      log: (...a) => this.logger.info?.(...a),
      warn: (...a) => this.logger.warn?.(...a),
    });
  }

  // ── logging helpers ─────────────────────────────────────────────────────────
  #log(...a) { this.logger.info?.(...a); }
  #warn(...a) { this.logger.warn?.(...a); }

  // ── dedupe RESERVE / COMMIT helpers ──────────────────────────────────────────
  // The message pipeline (P1-1) and the recall/edit system path (P1-3) must
  // RESERVE a dedupe id (inspect only) and COMMIT it ONLY once the work the id
  // represents has genuinely succeeded (delivered ok, or terminally consumed by a
  // policy reject / callback success). Committing before the work succeeds would
  // block redelivery of a message that never entered the runtime context.
  //
  // The default deduper (createDeduper) exposes has()/commit(); a legacy
  // adapter-supplied plain-function `callbacks.dedupe` has neither, so we degrade
  // to check-and-record (peek records eagerly, commit is then a no-op) — the old
  // behavior, only for that legacy shape.
  #dedupeHas(id) {
    if (!id) return false;
    if (typeof this._dedupe.has === 'function') return this._dedupe.has(id);
    return this._dedupe(id);   // legacy callable: check-and-record
  }
  #dedupeCommit(id) {
    if (!id) return;
    if (typeof this._dedupe.commit === 'function') this._dedupe.commit(id);
    // legacy callable already recorded during #dedupeHas — nothing to do.
  }

  // ── protocol read helpers (thin http wrappers, cached; port of comm-bridge) ──
  #ap(p) { return this.http.apiPath(p); }

  async #fetchMessageDetail(orgId, conversationId, messageId) {
    try {
      return await this.http.getForOrg(orgId, this.#ap(`/conversations/${conversationId}/messages/${messageId}`));
    } catch (e) {
      this.#warn(`fetchMessageDetail conv=${conversationId} msg=${messageId} failed: ${e.message}`);
      return null;
    }
  }

  async #fetchConversation(orgId, conversationId) {
    if (this._convCache.has(conversationId)) return this._convCache.get(conversationId);
    try {
      const conv = await this.http.getForOrg(orgId, this.#ap(`/conversations/${conversationId}`));
      this._convCache.set(conversationId, conv);
      return conv;
    } catch (e) {
      this.#warn(`fetchConversation ${conversationId} failed: ${e.message}`);
      return null;
    }
  }

  // Owner lookup for the DM sibling-agent exemption. Prefers an adapter-supplied
  // resolver; otherwise reads owner_member_id from cws-core with a short-TTL
  // cache (fail-closed: returns '' on miss/error → "not a sibling"). Port of
  // comm-bridge fetchMemberOwner.
  #fetchMemberOwner = async (orgId, memberId) => {
    if (this.callbacks.fetchMemberOwner) return this.callbacks.fetchMemberOwner(orgId, memberId);
    if (!memberId) return '';
    const key = `${orgId}:${memberId}`;
    const hit = this._memberOwnerCache.get(key);
    if (hit && Date.now() - hit.ts < MEMBER_OWNER_TTL_MS) return hit.ownerId;
    try {
      const m = await this.http.getForOrg(orgId, this.#ap(`/members/${memberId}`));
      const ownerId = m?.owner_member_id || '';
      this._memberOwnerCache.set(key, { ownerId, ts: Date.now() });
      return ownerId;
    } catch (e) {
      this.#warn(`fetchMemberOwner ${memberId} failed: ${e.message}`);
      return '';
    }
  };

  #markRead(orgConfig, conversationId, seq) {
    if (!conversationId || !seq) return;
    this.http.postForOrg(orgConfig.org_id, this.#ap(`/conversations/${conversationId}/read`), { read_until_seq: seq })
      .then(() => this.#log(`[${orgConfig.slug}] marked read conv=${conversationId} seq=${seq}`))
      .catch(e => this.#warn(`[${orgConfig.slug}] mark-read failed conv=${conversationId}: ${e.message}`));
  }

  // Polite refusal back to the sender for a policy drop with a userNotice. Pure
  // cws-core protocol (posts an AGENT_TEXT reply); NOT a C4 concern. Best-effort.
  async #sendRejectNotice(orgConfig, msg, text) {
    try {
      await this.http.postForOrg(orgConfig.org_id, this.#ap(`/conversations/${msg.conversation_id}/messages`), {
        client_msg_id: newClientMsgId(),
        type: 'AGENT_TEXT',
        content: { content_type: 'text', body: { text }, attachments: [] },
        parent_id: String(msg.id),
      });
    } catch (e) {
      this.#warn(`[${orgConfig.slug}] reject notice for msg=${msg.id} failed: ${e.message}`);
    }
  }

  // ── inbound message pipeline (protocol-generic half of makeOrgMessageHandler) ─
  //
  // The C4/media/history/quoted/format/react/billing tail of the original
  // handler is DELIBERATELY absent — it lives behind InboundDelivery.deliver in
  // the adapter. This method stops at: dedupe → detail → hoist → ledger.record →
  // conversation → decideInbound → deliver (or reject-notice on a drop).
  #makeOrgMessageHandler(orgConfig, sessionRef, ledger) {
    return async (payload) => {
      const notification = payload?.payload || payload;
      const notifId = notification?.id;
      const notifConv = notification?.conversation_id;
      const notifSender = notification?.sender_id;
      this.#log(`[ws] [${orgConfig.slug}] message frame: id=${notifId || '<missing>'} conv=${notifConv || '<missing>'} sender=${notifSender || '?'}`);
      if (!notifId || !notifConv) return;

      // RESERVE vs COMMIT (P1-1). Dedupe + inbox-ledger + cursor/ack advancement
      // are the "consumed" markers. They must NOT be committed until the message
      // genuinely enters the runtime context (deliver → {ok:true}) OR is
      // terminally rejected by access policy (a policy reject IS consumed). On a
      // {ok:false} or a thrown deliver(), NONE of them advance and the handler
      // THROWS so the live path drops it (frame-dispatch guard catches) and the
      // /sync sweep does not advance its cursor past it → redelivered later.

      // (1) message-id dedupe — RESERVE (peek only; committed post-deliver).
      if (this.#dedupeHas(notifId)) {
        this.#log(`[ws] [${orgConfig.slug}] msg=${notifId} duplicate, skipping`);
        return;
      }

      // (2) fetch full message detail and merge over the notification frame.
      const detail = await this.#fetchMessageDetail(orgConfig.org_id, notification.conversation_id, notification.id);
      const msg = { ...notification, ...(detail || {}) };

      // (3) inbox-seq ledger — RESERVE (peek only; committed via record() post-
      // deliver). Source priority: sync-frame notification.seq, else detail.inbox_seq.
      const inboxSeq = (notification._via === 'sync' && typeof notification.seq === 'number')
        ? notification.seq
        : (detail?.inbox_seq ?? detail?.message?.inbox_seq ?? null);
      if (ledger && inboxSeq != null && ledger.has?.(inboxSeq)) {
        this.#log(`[ws] [${orgConfig.slug}] msg=${notifId} inbox_seq=${inboxSeq} already recorded, skipping`);
        return;
      }

      // Commit the "consumed" markers. Called on terminal outcomes only:
      // deliver {ok:true}, or a terminal policy reject.
      const commitConsumed = () => {
        this.#dedupeCommit(notifId);
        if (ledger && inboxSeq != null) ledger.record(inboxSeq);
      };

      // (4) hoist scalar fields the sync-catch-up envelope nests under `message`
      // so downstream consumers see a uniform shape regardless of arrival path.
      if (!msg.sender_id && msg.message?.sender_id) msg.sender_id = msg.message.sender_id;
      if (msg.seq == null && msg.message?.seq != null) msg.seq = msg.message.seq;
      if (!msg.type && msg.message?.type) msg.type = msg.message.type;
      if (!msg.thread_id && msg.message?.thread_id) msg.thread_id = msg.message.thread_id;
      if (!msg.parent_message_id && msg.message?.parent_message_id) {
        msg.parent_message_id = msg.message.parent_message_id;
      }

      // (5) conversation lookup (frame carries id, not type).
      const conv = await this.#fetchConversation(orgConfig.org_id, msg.conversation_id);
      if (conv) conv.id = conv.id || msg.conversation_id;

      // (6) access-policy engine.
      const decision = await decideInbound(msg, conv || {}, orgConfig, {
        fetchMemberOwner: this.#fetchMemberOwner,
      });
      if (!decision.handle) {
        this.#log(`drop [${orgConfig.slug}] msg=${msg.id}: ${decision.reason}`);
        // A policy reject is TERMINAL/consumed — the message will never enter the
        // runtime context and must not be redelivered forever, so COMMIT the
        // dedupe + ledger markers here (before posting the notice).
        commitConsumed();
        // Reject notice: skip on sync-replay (stale spam) and to AGENT senders
        // (avoids reject-notice ping-pong) — mirrors comm-bridge exactly.
        const senderType = String(msg.sender_type || msg.message?.sender_type || '').toUpperCase();
        const isSyncReplay = notification._via === 'sync';
        const isAgentSender = senderType === 'AGENT';
        if (decision.userNotice && !isSyncReplay && !isAgentSender) {
          this.#sendRejectNotice(orgConfig, msg, decision.userNotice).catch(() => {});
        }
        return;
      }

      // (7) owner hints from the decision — apply in place (parity with
      // comm-bridge) AND surface via callbacks so the adapter can persist to
      // config.json. The SDK never writes config itself.
      if (decision.bindOwnerHint) {
        const { memberId, displayName } = decision.bindOwnerHint;
        this.#log(`bind owner (fallback, core had none) [${orgConfig.slug}] member_id=${memberId} name="${displayName}"`);
        orgConfig.owner = { member_id: memberId, name: displayName || '' };
        this.callbacks.onOwnerBind?.(orgConfig.slug, memberId, displayName || '');
      } else if (decision.ownerNameHint) {
        orgConfig.owner = { ...(orgConfig.owner || {}), name: decision.ownerNameHint };
        this.callbacks.onOwnerNameHint?.(orgConfig.slug, decision.ownerNameHint);
      }

      // (8) normalize → deliver. The adapter's InboundDelivery does all C4 /
      // media / history / formatting from here.
      //
      // COMMIT only on {ok:true}. On {ok:false} or a thrown deliver() we do NOT
      // commit dedupe/ledger and we THROW so:
      //   - live WS path: frame-dispatch's guard catches → logged, no
      //     unhandledRejection, markers untouched → redelivered on next /sync;
      //   - /sync path: the throw aborts the sweep before this event's seq
      //     advances `sinceSeq`, so the sync cursor never moves past it.
      const inbound = this.#buildInbound(orgConfig, msg, conv, decision, notification);
      let res;
      try {
        res = await this.providers.inbound.deliver(inbound, inbound.endpoint, inbound.priority);
      } catch (e) {
        this.#warn(`[${orgConfig.slug}] inbound.deliver threw for msg=${inbound.messageId}: ${e.message} — NOT committing (dedupe/ledger/cursor held for redelivery)`);
        throw e;   // propagate: hold markers, let live-guard/​sync retry
      }
      const ok = res?.ok !== false;
      this.#log(`deliver [${orgConfig.slug}] ${inbound.conversationType} ${inbound.conversationId} msg=${inbound.messageId} seq=${inbound.seq} ok=${ok}`);
      if (!ok) {
        const cls = res?.failureClass ? ` failureClass=${res.failureClass}` : '';
        const retry = res?.retryAfterMs != null ? ` retryAfterMs=${res.retryAfterMs}` : '';
        this.#warn(`[${orgConfig.slug}] inbound.deliver returned ok:false for msg=${inbound.messageId}${cls}${retry} — NOT committing (dedupe/ledger/cursor held for redelivery)`);
        const err = new Error(`inbound delivery failed for msg=${inbound.messageId}`);
        if (res?.failureClass != null) err.failureClass = res.failureClass;
        if (res?.retryAfterMs != null) err.retryAfterMs = res.retryAfterMs;
        throw err;   // propagate: hold markers, let live-guard/​sync retry
      }
      // Success → COMMIT the consumed markers, then advance read state.
      commitConsumed();
      if (this.reporterOpts.markReadOnDeliver) {
        this.#markRead(orgConfig, msg.conversation_id, msg.seq);
      }
    };
  }

  // Build the normalized InboundMessage handed to InboundDelivery.deliver. Carries
  // the extracted essentials (text/type/attachments/endpoint/priority/decision)
  // PLUS the full merged raw frame (`message`) so the adapter can do media
  // download, history/context assembly, quoted-message expansion, and the C4
  // envelope without re-fetching.
  #buildInbound(orgConfig, msg, conv, decision, notification) {
    const structured = (msg.content && typeof msg.content === 'object') ? msg.content : {};
    const text =
         structured.body?.text
      || (typeof msg.message?.content === 'string' ? msg.message.content : '')
      || (typeof msg.content === 'string' ? msg.content : '')
      || '';
    const attachments = Array.isArray(structured.attachments) ? structured.attachments : [];
    const convType = (conv?.type || '').toLowerCase() || (msg.thread_id ? 'thread' : 'dm');
    const msgType = (msg.type || msg.message?.type || '').toLowerCase();
    const endpoint = formatEndpoint({
      type: convType,
      conversationId: msg.conversation_id,
      threadConversationId: msg.thread_id || undefined,
      parentMessageId: msg.thread_id ? msg.parent_message_id : undefined,
    });
    return {
      orgId: orgConfig.org_id,
      orgSlug: orgConfig.slug,
      orgName: orgConfig.org_name,
      conversation: conv || { id: msg.conversation_id },
      conversationId: msg.conversation_id,
      conversationType: convType,
      messageId: msg.id,
      seq: msg.seq,
      senderId: msg.sender_id,
      senderType: String(msg.sender_type || msg.message?.sender_type || ''),
      senderDisplayName: msg.sender_display_name || msg.sender?.display_name || '',
      type: msgType,
      text,
      attachments,
      parentMessageId: msg.parent_id || msg.message?.parent_id || msg.parent_message_id || null,
      threadId: msg.thread_id || null,
      endpoint,
      priority: systemEventPriority(msg),
      via: notification._via || 'ws',
      decision,
      message: msg,
    };
  }

  // ── system-frame handling (protocol-generic; classify + gate, hand off) ──────
  #makeOrgSystemHandler(orgConfig) {
    return async (frame, kind) => {
      const payload = frame.payload || {};
      if (!kind) {
        this.#warn(`[${orgConfig.slug}] unhandled system event: ${payload.event || '(unknown)'} conv=${payload.conversation_id || '?'}`);
        return;
      }

      // config-update / connection / channel: pure hand-off to adapter callbacks.
      // ALL adapter-callback seams are awaited + try/caught (P1-3) so an async
      // callback that rejects surfaces as a logged warning — never an
      // unhandledRejection (which can crash the bridge under Node).
      if (kind === 'config_update') {
        // "not for us" target check is protocol; persistence is the adapter's.
        const data = payload.data || {};
        if (data.agent_member_id && data.agent_member_id !== orgConfig.self?.member_id) {
          this.#log(`[${orgConfig.slug}] config event ${payload.event} not for us (target=${data.agent_member_id}), skip`);
          return;
        }
        try { await this.callbacks.onConfigEvent?.(orgConfig, { event: payload.event, data, frame }); }
        catch (e) { this.#warn(`[${orgConfig.slug}] onConfigEvent failed: ${e.message} — event not consumed, will retry on replay`); }
        return;
      }
      if (kind === 'connection') {
        try { await this.callbacks.onConnectionEvent?.(orgConfig, frame); }
        catch (e) { this.#warn(`[${orgConfig.slug}] onConnectionEvent: ${e.message}`); }
        return;
      }
      if (kind === 'channel') {
        try { await this.callbacks.onChannelEvent?.(orgConfig, frame); }
        catch (e) { this.#warn(`[${orgConfig.slug}] onChannelEvent: ${e.message}`); }
        return;
      }

      // recall / edit: dedupe → conversation → access-policy gate → hand off.
      const data = payload.data || {};
      const conversationId = payload.conversation_id || data.conversation_id;
      if (!conversationId) {
        this.#warn(`[${orgConfig.slug}] system ${payload.event}: missing conversation_id, skip`);
        return;
      }
      const messageId = data.message_id || data.id || data.msg_id || '';
      const dedupKey = `sys:${kind}:${conversationId}:${messageId || payload.event}`;
      // RESERVE (peek only). The dedupe is COMMITTED only after onSystemNotice
      // resolves successfully (P1-3) — otherwise a rejecting notice callback would
      // dedupe (consume) the event and lose it on replay.
      if (this.#dedupeHas(dedupKey)) {
        this.#log(`[${orgConfig.slug}] system ${kind} dedup msg=${messageId}`);
        return;
      }

      const actorId = data.recalled_by || data.edited_by || data.sender_id || '';
      const conv = await this.#fetchConversation(orgConfig.org_id, conversationId);
      const convType = (conv?.type || '').toLowerCase() || 'dm';
      const syntheticMsg = {
        conversation_id: conversationId,
        sender_id: actorId,
        sender_type: data.sender_type || 'HUMAN',
      };
      const decision = await decideInbound(syntheticMsg, conv || {}, orgConfig, {
        fetchMemberOwner: this.#fetchMemberOwner,
      });
      if (!decision.handle) {
        this.#log(`drop [${orgConfig.slug}] system ${kind} msg=${messageId}: ${decision.reason}`);
        return;
      }

      // Adapter formats the notice text (C4 concern) and delivers it. The SDK
      // provides the classified, policy-gated event plus resolved conversation.
      // Awaited + try/caught: COMMIT the dedupe ONLY once the adapter callback
      // resolves successfully. A rejection is logged (no unhandledRejection) and
      // leaves the event un-deduped so a re-sent frame is retried (P1-3).
      const endpoint = formatEndpoint({ type: convType, conversationId });
      try {
        await this.callbacks.onSystemNotice?.(orgConfig, {
          kind,                 // 'recall' | 'edit'
          event: payload.event,
          conversationId,
          conversation: conv,
          conversationType: convType,
          messageId,
          actorId,
          senderType: syntheticMsg.sender_type,
          endpoint,
          priority: systemEventPriority(syntheticMsg),
          data,
          decision,
          frame,
        });
        this.#dedupeCommit(dedupKey);
      } catch (e) {
        this.#warn(`[${orgConfig.slug}] onSystemNotice failed for ${kind} msg=${messageId}: ${e.message} — event not consumed, will retry on replay`);
      }
    };
  }

  // ── per-org WS lifecycle (port of startOrgWs) ────────────────────────────────
  async #startOrgWs(orgConfig) {
    const slug = orgConfig.slug;

    // Session cursor: warm-restart from persisted sync_seq (migrate last_seq).
    let session = {};
    try {
      session = (await this.callbacks.loadSession?.(slug)) || {};
    } catch (e) {
      this.#warn(`[${slug}] loadSession failed: ${e.message}`);
    }
    const syncSeq = session.sync_seq ?? session.last_seq ?? 0;
    const sessionRef = { sync_seq: syncSeq };
    if (sessionRef.sync_seq) this.#log(`[${slug}] warm-restart: sync_seq=${sessionRef.sync_seq}`);

    // SyncEngine — one per org, its onMessage bound to THIS org's pipeline so
    // /sync catch-up events flow through the same dedupe→policy→deliver path.
    const sync = new SyncEngine({
      http: this.http,
      onMessage: (ev) => handleIncomingMessage(ev),
      saveSession: (s, partial) => { try { this.callbacks.saveSession?.(s, partial); } catch {} },
      logger: this.logger,
      deviceId: this.wsOpts.deviceId,
      appVersion: this.wsOpts.clientVersion,
    });

    // Inbox-seq ledger — continuous-ack watermark + gap detection. onAck syncs
    // the session cursor + acks to cws-comm; onGapSync runs a /sync sweep. Wiring
    // order (ledger ← sync) mirrors comm-bridge startOrgWs exactly.
    const ledger = createInboxLedger(slug, {
      log: (...a) => this.#log(`[${slug}]`, ...a),
      storage: this.providers.storage,
      onAck: (ackedSeq) => {
        sessionRef.sync_seq = ackedSeq;
        try { this.callbacks.saveSession?.(slug, { sync_seq: ackedSeq }); } catch {}
        sync.ackSync(orgConfig, ackedSeq);
      },
      onGapSync: () => { sync.syncMissedEvents(orgConfig, sessionRef); },
    });
    await ledger.load();
    if (syncSeq > 0) ledger.setAckedSeq(syncSeq);
    ledger.start();

    const handleIncomingMessage = this.#makeOrgMessageHandler(orgConfig, sessionRef, ledger);
    const onSystem = this.#makeOrgSystemHandler(orgConfig);

    // Frame dispatch — classify each frame, route to the typed handlers.
    const onFrame = createFrameDispatcher({
      onMessage: (frame) => handleIncomingMessage(frame),
      onSystem,
      onFrameType: (type) => {
        const k = `${slug}/${type || '(missing-type)'}`;
        this._frameCounts[k] = (this._frameCounts[k] || 0) + 1;
        this.callbacks.onFrameType?.(slug, type);
      },
    }, { log: (...a) => this.#log(`[${slug}]`, ...a), warn: (...a) => this.#warn(`[${slug}]`, ...a) });

    const wsBaseUrl = this.wsOpts.baseUrl;
    const urlProvider = this.wsOpts.urlProvider
      ? () => this.wsOpts.urlProvider(orgConfig)
      : async () => {
          // Readiness barrier per (re)connect leg: no frame reaches the mention
          // gate until hydration resolves. Never throws (fail-open); then mint
          // the one-shot ws-ticket and append it to the base URL.
          await this._hydrateSelfName(orgConfig, { maxAttempts: 1 });
          if (!this.tokenManager) throw new Error('no tokenManager to mint ws-ticket');
          this.#log(`[ticket] org=${slug} requesting ws-ticket`);
          const ticket = await this.tokenManager.getWsTicket(orgConfig.org_id);
          this.#log(`[ticket] org=${slug} got ws-ticket, connecting…`);
          return `${wsBaseUrl}?ticket=${encodeURIComponent(ticket)}`;
        };

    const ws = new WsClient({
      urlProvider,
      deviceId: this.wsOpts.deviceId,
      clientVersion: this.wsOpts.clientVersion,
      reconnectMaxMs: this.wsOpts.reconnectMaxMs,
      heartbeatIntervalMs: this.wsOpts.heartbeatIntervalMs,
      pingIntervalMs: this.wsOpts.pingIntervalMs,
      cfAccess: this.wsOpts.cfAccess,
      wsFactory: this.wsOpts.wsFactory,
      logger: {
        log: (...a) => this.#log(...a),
        warn: (...a) => this.#warn(...a),
        error: (...a) => this.logger.error?.(...a),
      },
      onOpen: async () => {
        this.#log(`[ws] org=${slug} open (org_id=${orgConfig.org_id})`);
        // Online self-report (onboarding trigger); best-effort, retried on
        // reconnect. Fired here, matching comm-bridge onOpen order.
        this._reportAgentOnline(orgConfig).catch(e =>
          this.#warn(`[${slug}] online-report failed: ${e.message} — will retry on next reconnect`));
        if (!sessionRef.sync_seq) {
          // First-ever connect: seek to inbox end, seed the ledger.
          await sync.initSyncSeq(orgConfig, sessionRef);
          if (sessionRef.sync_seq) ledger.setAckedSeq(sessionRef.sync_seq);
        } else {
          // Reconnect: catch up events missed across the disconnect.
          sync.syncMissedEvents(orgConfig, sessionRef);
        }
      },
      onMessage: onFrame,
      onClose: (code, reason, willReconnect) => {
        this.#log(`[${slug}] closed code=${code} reason="${reason || ''}" reconnect=${willReconnect}`);
        if (code === 4003) {
          // Session expired: drop cached JWT/ticket; keep sync_seq for catch-up.
          this.#log(`[${slug}] session expired; invalidating token cache (sync_seq preserved)`);
          this.tokenManager?.invalidate(orgConfig.org_id);
        }
      },
      onFatal: (code, reason) => {
        this.logger.error?.(`[${slug}] FATAL close code=${code} reason="${reason || ''}" — stopping this org`);
        this._liveOrgCount -= 1;
        this.callbacks.onOrgTerminated?.(orgConfig, code, reason);
        if (this._liveOrgCount <= 0) {
          this.logger.error?.('all orgs terminated');
          this.callbacks.onAllOrgsTerminated?.();
        }
      },
    });

    this._orgs.set(slug, { orgConfig, sessionRef, ledger, sync, ws, onFrame, handleIncomingMessage });
    this._liveOrgCount += 1;
    ws.start();
    this.#log(`[${slug}] started (org=${orgConfig.org_id})`);
  }

  // ── lifecycle ────────────────────────────────────────────────────────────────

  /**
   * Bootstrap tokens + self-name (pre-connect barrier), open one WS per org,
   * then arm the process-wide periodic reporters. Idempotent-guarded.
   */
  async start() {
    if (this._started) return;
    this._started = true;

    if (this.orgConfigs.length === 0) {
      this.#warn('no org configs — nothing to start');
    }

    // Pre-mint each org's JWT and hydrate the authoritative self display_name in
    // parallel BEFORE the WS loop, so member_id write-back AND @-mention name
    // readiness land before the first frame. Each WS still re-runs the barrier in
    // its urlProvider, so a failed bootstrap does not block startup.
    await Promise.allSettled(this.orgConfigs.map(async (orgConfig) => {
      this.#log(`[bootstrap] org=${orgConfig.slug} (${orgConfig.org_id}) acquiring JWT + hydrating self display_name…`);
      const res = await this._hydrateSelfName(orgConfig);
      this.#log(`[bootstrap] org=${orgConfig.slug} self-name readiness: ready=${res.ready} source=${res.source}${res.displayName ? ` ("${res.displayName}")` : ''}`);
    }));

    for (const orgConfig of this.orgConfigs) {
      await this.#startOrgWs(orgConfig);
    }

    this.#armReporters();
  }

  #armReporters() {
    if (this.reporterOpts.metricsEnabled) {
      // Build an activeOrgConfigs map the metrics reporter expects (slug → cfg).
      const activeOrgConfigs = new Map();
      for (const [slug, rec] of this._orgs) activeOrgConfigs.set(slug, rec.orgConfig);
      const reportMetrics = createMetricsReporter(activeOrgConfigs, {
        http: this.http,
        runtimeState: this.providers.runtimeState,
        logger: this.logger,
        version: this.reporterOpts.version,
      });
      const arm = () => {
        const t = setInterval(() => { reportMetrics().catch(() => {}); }, this.reporterOpts.metricsIntervalMs);
        t.unref?.();
        this._timers.push(t);
      };
      if (this.reporterOpts.metricsInitialDelayMs > 0) {
        const d = setTimeout(arm, this.reporterOpts.metricsInitialDelayMs);
        d.unref?.();
        this._timers.push(d);
      } else {
        arm();
      }
    }

    if (this.reporterOpts.frameMetrics) {
      const t = setInterval(() => this.#dumpFrameMetrics(), FRAME_METRIC_INTERVAL_MS);
      t.unref?.();
      this._timers.push(t);
    }
  }

  #dumpFrameMetrics() {
    const entries = Object.entries(this._frameCounts);
    if (entries.length === 0) {
      this.#log('ws frame metric: no frames received in this window');
      return;
    }
    entries.sort((a, b) => b[1] - a[1]);
    this.#log(`ws frame metric (cumulative since boot): ${entries.map(([k, n]) => `${k}=${n}`).join(' ')}`);
  }

  /**
   * Disarm every timer and close every WS + ledger with no leaks. Awaitable —
   * resolves once all ledgers have flushed their final persist.
   */
  async stop() {
    for (const t of this._timers) { try { clearInterval(t); clearTimeout(t); } catch {} }
    this._timers = [];
    const flushes = [];
    for (const [, rec] of this._orgs) {
      try { rec.ws.stop(); } catch {}
      try { flushes.push(Promise.resolve(rec.ledger.stop())); } catch {}
    }
    await Promise.allSettled(flushes);
    this._orgs.clear();
    this._liveOrgCount = 0;
    this._started = false;
    this.#log('shutdown complete');
  }

  // ── outbound helper (runtime reply → cws-core /messages) ─────────────────────
  /**
   * Send an outbound message to cws-core (the old scripts/send.js path). The
   * endpoint string is parsed for conversation/thread/reply routing.
   * @param {string} endpoint  formatEndpoint()-shaped routing string
   * @param {string} content   message text
   * @param {object} [opts]
   * @param {string} [opts.orgId]     org to send as (else the client's default org)
   * @param {string} [opts.replyTo]   parent message id (reply)
   * @param {string} [opts.type]      message type (default 'AGENT_TEXT')
   * @returns {Promise<{messageId: string}>}
   */
  async send(endpoint, content, opts = {}) {
    const ep = parseEndpoint(endpoint);   // throws on an invalid endpoint
    const conversationId = ep.threadConversationId || ep.conversationId;
    if (!conversationId) throw new Error(`send: cannot resolve conversation from endpoint "${endpoint}"`);
    const orgId = opts.orgId;
    const body = {
      client_msg_id: newClientMsgId(),
      type: opts.type || 'AGENT_TEXT',
      content: { content_type: 'text', body: { text: content }, attachments: [] },
    };
    const replyTo = opts.replyTo || ep.replyTo || ep.parentMessageId;
    if (replyTo) body.parent_id = String(replyTo);
    const res = orgId
      ? await this.http.postForOrg(orgId, this.#ap(`/conversations/${conversationId}/messages`), body)
      : await this.http.post(this.#ap(`/conversations/${conversationId}/messages`), body);
    return { messageId: res?.id || res?.message?.id || res?.message_id || '' };
  }

  /**
   * Drive a raw frame through a started org's dispatcher — the same path a live
   * WS frame takes. Used by tests and manual replay; returns nothing.
   * @param {string} slug
   * @param {object} frame
   */
  injectFrame(slug, frame) {
    const rec = this._orgs.get(slug);
    if (!rec) throw new Error(`injectFrame: org "${slug}" not started`);
    rec.onFrame(frame);
  }
}
