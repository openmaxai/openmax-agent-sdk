/**
 * WebSocket client for cws-comm.
 *
 * Aligned with cws-comm api-design.md §3-§4:
 *   - Auth:       Bearer token in connect headers, plus X-Workspace-Id
 *   - Heartbeat:  JSON ping/pong text frames (NOT WS-level ping/pong);
 *                 server initiates ping, client replies pong within
 *                 cws-comm-configured pongTimeout (default 10s).
 *                 If we receive no frame at all for >
 *                 heartbeatIntervalMs * (maxMissedPongs+1) + grace
 *                 we proactively terminate to force a reconnect.
 *   - Reconnect:  exponential backoff 1s → 2s → 4s → ... capped at
 *                 reconnect_max_delay (default 30s).
 *   - Close codes (§4.5):
 *       1000 / 1001  — normal close, reconnect
 *       4001         — heartbeat timeout, reconnect
 *       4002         — auth failed, STOP (caller alerts)
 *       4003         — session expired, caller should clear session
 *                      then reconnect with api_key
 *       4004         — rate limited, reconnect with longer delay
 *       4005         — workspace suspended, STOP
 *       4006         — duplicate connection, STOP
 *
 * Callbacks (all optional):
 *   onOpen(client)
 *   onMessage(frame)                — frame is parsed JSON, includes ping/pong
 *   onClose(code, reason, willReconnect)
 *   onFatal(code, reason)           — invoked instead of onClose when a
 *                                     terminal close code (4002/4005/4006) hits
 *
 * The client auto-replies to `{type:'ping'}` frames with `{type:'pong'}` —
 * the message handler receives the ping but does NOT need to reply.
 *
 * Extraction note: the only changes vs the zylos-openmax source are (1) logging
 * is routed through an injected `logger` (defaults to `console`, so behavior is
 * unchanged out of the box), (2) an optional `cfAccess` config object is
 * threaded into cfAccessHeaders() (env still works with no config), and (3) the
 * temporary `[ws] ping received` debug console.log was removed — the intended
 * behavior (advancing lastFrameAt on server WS pings) is preserved.
 */

import fs from 'fs';
import path from 'path';
import WebSocket from 'ws';
import { cfAccessHeaders } from './cf-access.js';

const RECONNECT_BASE_MS = 1000;
const FRAME_GRACE_MS = 5000;
const TERMINAL_CLOSE_CODES = new Set([4002, 4005, 4006]);
const RATE_LIMITED_CLOSE_CODES = new Set([4004]);

export class WsClient {
  constructor({
    url,
    urlProvider,            // optional async () => string; if present, called
                            // before each connect to mint a fresh URL (e.g.
                            // to fetch a one-shot ticket and append it).
                            // If it throws, the connect is retried via the
                            // normal backoff loop.
    token,
    workspaceId,
    deviceId,
    clientVersion,
    reconnectMaxMs = 30000,
    heartbeatIntervalMs = 30000,
    // Client-initiated WS-level ping cadence. The server-side path does NOT
    // guarantee that server pings reach us (on prod they don't traverse the
    // path at all), so the client must feed the frame-watchdog itself by
    // sending its own periodic ping; the elicited pong advances lastFrameAt.
    // Must stay comfortably below the watchdog window
    // (heartbeatIntervalMs * 2 + FRAME_GRACE_MS = 65s at defaults).
    pingIntervalMs = 20000,
    onOpen,
    onMessage,
    onClose,
    onFatal,
    // Optional factory for the underlying WebSocket, for testability. Defaults
    // to the real `ws` implementation.
    wsFactory,
    // Optional cf_access config object ({ cf_access: { client_id, client_secret } }).
    // When omitted, CF-Access headers come from env only.
    cfAccess,
    // Optional logger ({ log, warn, error }). Defaults to console — byte-for-byte
    // identical to the source's bare console.* calls.
    logger,
  }) {
    this.url = url;
    this.urlProvider = urlProvider || null;
    this.token = token;
    this.workspaceId   = workspaceId   || '';
    this.deviceId      = deviceId      || '';
    this.clientVersion = clientVersion || '';
    this.reconnectMaxMs = reconnectMaxMs;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.pingIntervalMs = pingIntervalMs;
    this.onOpen    = onOpen    || (() => {});
    this.onMessage = onMessage || (() => {});
    this.onClose   = onClose   || (() => {});
    this.onFatal   = onFatal   || (() => {});
    this.wsFactory = wsFactory || ((u, opts) => new WebSocket(u, opts));
    this.cfAccess  = cfAccess;
    this.logger    = logger || console;

    this.ws = null;
    this.stopped = false;
    this.reconnectAttempt = 0;
    this.frameWatchdog = null;
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.lastFrameAt = 0;
  }

  start() {
    this.stopped = false;
    this._connect().catch(err => this.logger.error('[ws] connect threw:', err.message));
  }

  stop() {
    this.stopped = true;
    this._clearTimers();
    if (this.ws) {
      try { this.ws.close(1000, 'client stop'); } catch {}
      this.ws = null;
    }
  }

  /**
   * Update the auth token for the next connection (e.g. after handshake
   * yields a session_token, or after 4003 we fall back to api_key).
   */
  setToken(token) { this.token = token; }

  send(payload) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not open');
    }
    this.ws.send(typeof payload === 'string' ? payload : JSON.stringify(payload));
  }

  isOpen() { return this.ws && this.ws.readyState === WebSocket.OPEN; }

  async _connect() {
    let url = this.url;
    if (this.urlProvider) {
      try {
        url = await this.urlProvider();
      } catch (err) {
        this.logger.error('[ws] urlProvider failed:', err.message);
        // Respect Retry-After hints from cws-core when fetching ws-ticket
        const retryHint = Number(err.retryAfterMs) || 0;
        if (!this.stopped) this._scheduleReconnect(false, retryHint);
        return;
      }
    }
    if (!url) {
      this.logger.error('[ws] no URL to connect to');
      if (!this.stopped) this._scheduleReconnect(false);
      return;
    }

    const headers = { ...cfAccessHeaders(this.cfAccess) };
    if (this.token)         headers.Authorization      = `Bearer ${this.token}`;
    if (this.workspaceId)   headers['X-Workspace-Id']  = this.workspaceId;
    if (this.deviceId)      headers['X-Device-Id']     = this.deviceId;
    if (this.clientVersion) headers['X-Client-Version'] = this.clientVersion;

    this.ws = this.wsFactory(url, { headers });
    this.lastFrameAt = Date.now();

    this.ws.on('open', () => {
      this.reconnectAttempt = 0;
      this._startFrameWatchdog();
      this._startKeepalivePing();
      this.onOpen(this);
    });

    this.ws.on('message', (raw) => {
      this.lastFrameAt = Date.now();
      let frame;
      try { frame = JSON.parse(raw.toString()); } catch { return; }

      // Auto-reply to JSON ping with JSON pong (cws-comm §4.3).
      if (frame.type === 'ping') {
        try { this.send({ type: 'pong', timestamp: Date.now() }); } catch {}
      }
      this.onMessage(frame);
    });

    // WS protocol-level control frames. The npm `ws` lib auto-replies to
    // server Pings with Pongs (no action needed here), but it does NOT fire
    // the 'message' event for control frames — so without these listeners
    // `lastFrameAt` would stay at the open timestamp even while heartbeats
    // are flowing, and the frame watchdog would kill a perfectly healthy
    // connection. cws-comm uses WS-level Ping/Pong (see
    // cws-comm internal/transport/ws/conn.go RunPingLoop), so this matters.
    this.ws.on('ping', () => {
      this.lastFrameAt = Date.now();
    });
    this.ws.on('pong', () => {
      this.lastFrameAt = Date.now();
    });

    this.ws.on('close', (code, reasonBuf) => {
      this._clearTimers();
      const reason = reasonBuf?.toString?.() || '';
      const terminal = TERMINAL_CLOSE_CODES.has(code);
      const rateLimited = RATE_LIMITED_CLOSE_CODES.has(code);

      if (terminal) {
        this.stopped = true;
        this.onFatal(code, reason);
        return;
      }
      const willReconnect = !this.stopped;
      this.onClose(code, reason, willReconnect);
      if (willReconnect) this._scheduleReconnect(rateLimited);
    });

    this.ws.on('error', (err) => {
      // 'close' fires after error; just log
      this.logger.error('[ws] error:', err.message);
    });
  }

  _scheduleReconnect(rateLimited) {
    const base = rateLimited ? Math.max(RECONNECT_BASE_MS * 8, 5000) : RECONNECT_BASE_MS;
    const delay = Math.min(base * (2 ** this.reconnectAttempt), this.reconnectMaxMs);
    this.reconnectAttempt += 1;
    this.logger.log(`[ws] reconnecting in ${delay}ms (attempt #${this.reconnectAttempt})`);
    this.reconnectTimer = setTimeout(() => {
      if (!this.stopped) this._connect();
    }, delay);
  }

  /**
   * If we receive no frames at all for more than the watchdog window,
   * the connection is dead — terminate to trigger reconnect. The window
   * is sized to allow for one missed ping (server pings every interval,
   * client must pong; if server stops pinging it's down).
   */
  _startFrameWatchdog() {
    this._clearTimers();
    const watchdogMs = (this.heartbeatIntervalMs * 2) + FRAME_GRACE_MS;
    this.frameWatchdog = setInterval(() => {
      if (Date.now() - this.lastFrameAt > watchdogMs) {
        this.logger.warn('[ws] no frames received within watchdog window, terminating');
        try { this.ws.terminate(); } catch {}
      }
    }, this.heartbeatIntervalMs);
  }

  /**
   * Send our own WS-level ping on a fixed cadence so the frame-watchdog is fed
   * regardless of whether SERVER pings ever reach us. On prod, server pings do
   * not traverse the path, so a quiet org would otherwise starve the watchdog
   * (heartbeatIntervalMs*2 + grace) and churn with close code 1006 every few
   * minutes. An RFC-compliant server — or the nearest terminating proxy —
   * auto-replies with a pong, and the existing `on('pong')` handler advances
   * lastFrameAt. This also keeps the pipe warm through intermediaries (the
   * standard IM keepalive direction). Purely additive: the server-side ping
   * path and the watchdog are unchanged.
   */
  _startKeepalivePing() {
    if (this.pingTimer) return;   // guard against double-arming
    this.pingTimer = setInterval(() => {
      try {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.ping();
      } catch {}
    }, this.pingIntervalMs);
  }

  _clearTimers() {
    if (this.frameWatchdog) { clearInterval(this.frameWatchdog); this.frameWatchdog = null; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
  }
}

/**
 * Message deduplication by message_id, retaining the most recent N ids.
 *
 * Returns a function that takes a message id and returns true if it was already
 * seen (within the retained window), false otherwise (and records it).
 *
 * Retention is COUNT-based (keep the most recent `maxEntries` ids), NOT
 * time-based. Rationale: a reconnect/restart catch-up can replay up to
 * SYNC_MAX_EVENTS (2000) events regardless of how long the bot was offline, so
 * a fixed-size recent-id window guarantees those replays are deduped. A short
 * TTL (the previous behavior) let ids age out mid-catch-up and leaked
 * duplicates after a >TTL outage.
 *
 * `opts.persistPath` (optional): back the seen-id window with a JSON file so it
 * survives a process restart (debounced atomic write; loaded + capped on init).
 * Best-effort — fs errors are swallowed and the deduper degrades to in-memory.
 * The path is supplied by the caller (never hard-coded), so this stays runtime-
 * agnostic; adapters resolve it via their StorageProvider.
 * `opts.maxEntries` (default 5000): retained-id count; must exceed
 * SYNC_MAX_EVENTS so a full catch-up sweep is always covered.
 */
export function createDeduper(optsOrLegacyTtl = {}, legacyOpts) {
  // Backward compat: old call-sites passed (ttlMs, opts); new ones pass (opts).
  const opts = typeof optsOrLegacyTtl === 'object' ? optsOrLegacyTtl : (legacyOpts || {});
  const { persistPath = null, maxEntries = 5000 } = opts;
  const seen = new Map();   // id -> first-seen ts(ms); Map insertion order = age

  function evictOverflow() {
    while (seen.size > maxEntries) {
      const oldest = seen.keys().next().value;
      if (oldest === undefined) break;
      seen.delete(oldest);
    }
  }

  if (persistPath) {
    try {
      const raw = JSON.parse(fs.readFileSync(persistPath, 'utf-8'));
      for (const [k, t] of Object.entries(raw)) {
        if (typeof t === 'number') seen.set(k, t);
      }
      evictOverflow();   // keep only the most recent maxEntries on load
    } catch { /* missing/corrupt → start empty */ }
  }

  let dirty = false;
  let flushTimer = null;
  function flush() {
    flushTimer = null;
    if (!persistPath || !dirty) return;
    dirty = false;
    try {
      fs.mkdirSync(path.dirname(persistPath), { recursive: true });
      const tmp = `${persistPath}.tmp.${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(seen)));
      fs.renameSync(tmp, persistPath);
    } catch { /* best-effort */ }
  }
  function scheduleFlush() {
    if (!persistPath || flushTimer) return;
    flushTimer = setTimeout(flush, 1000);
    flushTimer.unref?.();
  }

  // COMMIT — record `id` as seen. Idempotent; returns true if it was already
  // present (i.e. a duplicate), false if this call is what recorded it.
  function commit(id) {
    if (!id) return false;
    if (seen.has(id)) return true;
    seen.set(id, Date.now());
    evictOverflow();
    dirty = true; scheduleFlush();
    return false;
  }
  // PEEK — is `id` already recorded? Does NOT record (no side effects). Lets a
  // caller RESERVE-then-COMMIT: inspect first, and only commit once the work the
  // id represents has genuinely succeeded (see orchestrator P1-1/P1-3).
  function has(id) {
    if (!id) return false;
    return seen.has(id);
  }
  // ROLLBACK — undo a commit (best-effort). Used when a committed id must be
  // released because the downstream work failed after all.
  function rollback(id) {
    if (!id) return;
    if (seen.delete(id)) { dirty = true; scheduleFlush(); }
  }

  // The deduper is callable for backward-compat (legacy check-and-record: returns
  // true if duplicate, else records + returns false) AND carries has/commit/
  // rollback so reserve/commit callers can separate inspection from recording.
  const dedupe = (id) => commit(id);
  dedupe.has = has;
  dedupe.commit = commit;
  dedupe.rollback = rollback;
  return dedupe;
}
