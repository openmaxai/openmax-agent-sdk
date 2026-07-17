/**
 * CWS frame dispatch — classifies inbound cws-comm WS frames and routes them to
 * adapter-supplied typed handlers.
 *
 * Extracted from zylos-openmax `src/comm-bridge.js` `makeOrgFrameDispatcher`
 * (top-level frame routing) and `classifySystemEvent` (system sub-classing).
 *
 * The transport layer (`transport/ws.js`) already:
 *   - parses the raw text into a JSON `frame` before calling `onMessage(frame)`,
 *   - auto-replies to `{type:'ping'}` with `{type:'pong'}` and advances its
 *     frame-watchdog on WS-level pings.
 * So this module receives already-parsed frames and only decides *what kind*
 * each frame is and *which handler* should see it. It contains NO C4 bridging,
 * NO message assembly, and NO system-event side effects — a `system` frame is
 * classified and handed to `onSystem(frame, kind)`; the orchestrator/adapter
 * performs the actual recall/edit/config/connection/channel handling.
 */

/** Top-level frame kinds (`classifyFrame` return values). */
export const FRAME_KIND = {
  MESSAGE: 'message',
  MESSAGE_ACK: 'message_ack',
  SYSTEM: 'system',
  ERROR: 'error',
  HEARTBEAT: 'heartbeat',   // ping / pong (transport already auto-replies)
  PRESENCE: 'presence',     // typing / presence / read_receipt / read_state_update
  UNKNOWN: 'unknown',
};

// Frame types that are transport/presence noise: acknowledged and dropped.
const PRESENCE_TYPES = new Set(['typing', 'presence', 'read_receipt', 'read_state_update', 'delivery_state_update']);
const HEARTBEAT_TYPES = new Set(['ping', 'pong']);

/**
 * Classify a parsed frame by its top-level `type`.
 * @param {{type?:string}} frame
 * @returns {string} one of FRAME_KIND
 */
export function classifyFrame(frame) {
  const type = frame?.type;
  if (type === 'message')      return FRAME_KIND.MESSAGE;
  if (type === 'message_ack')  return FRAME_KIND.MESSAGE_ACK;
  if (type === 'system')       return FRAME_KIND.SYSTEM;
  if (type === 'error')        return FRAME_KIND.ERROR;
  if (HEARTBEAT_TYPES.has(type)) return FRAME_KIND.HEARTBEAT;
  if (PRESENCE_TYPES.has(type))  return FRAME_KIND.PRESENCE;
  return FRAME_KIND.UNKNOWN;
}

/**
 * Sub-classify a `system` frame's `event` name into the handler bucket the
 * orchestrator/adapter should route it to.
 *
 * Event-name strings are cws-comm's authoritative domain event constants
 * (cws-comm internal/domain/message_events.go, *.EventName()):
 *   "message.recalled" / "message.deleted" -> recall
 *   "message.updated"                       -> edit  (cws-comm names edit
 *                                              "updated", not "edited")
 *   "agent.config.*"                        -> config_update
 *   "connection.*"                          -> connection
 *   "channel.*"                             -> channel  (adapter-only handling)
 * Ignored (returns null): message.created / .read / .delivered /
 *   .reaction.added / .reaction.removed / .mention.created.
 *
 * NB: the `channel.*` bucket is classified here (protocol) but its handling —
 * IM-channel install/connect via pm2 + `zylos` CLI — lives entirely in the
 * zylos-openmax adapter (owner decision 2026-07-17). The SDK never imports the
 * channel connector; it only tells the adapter "this is a channel event".
 *
 * @param {string} eventName
 * @returns {('recall'|'edit'|'config_update'|'connection'|'channel'|null)}
 */
export function classifySystemEvent(eventName) {
  const e = String(eventName || '').toLowerCase();
  if (e === 'message.recalled' || e === 'message.deleted') return 'recall';
  if (e === 'message.updated') return 'edit';
  if (e.startsWith('agent.config.')) return 'config_update';
  if (e.startsWith('connection.')) return 'connection';
  if (e.startsWith('channel.')) return 'channel';
  // Defensive fallback for naming drift — does not match reaction/read/etc.
  if (e.includes('recall') || e.includes('delete')) return 'recall';
  if (e.includes('edit') || e.includes('updat')) return 'edit';
  return null;
}

/**
 * Build a frame dispatcher — the function passed as `onMessage` to the WS
 * client. It classifies each frame and invokes the matching handler.
 *
 * Handlers are all optional; anything not supplied is a no-op (the frame is
 * still classified/logged). Async handlers (message / system) are guarded so a
 * rejected promise is routed to the logger instead of becoming an unhandled
 * rejection — mirroring the original `.catch(...)` sites.
 *
 * @param {object} [handlers]
 * @param {(frame:object) => (void|Promise<void>)} [handlers.onMessage]
 *        `message` frames (new message.created).
 * @param {(frame:object, kind:(string|null)) => (void|Promise<void>)} [handlers.onSystem]
 *        `system` frames, with the `classifySystemEvent` result as second arg.
 * @param {(frame:object) => void} [handlers.onMessageAck] server ack frames.
 * @param {(frame:object) => void} [handlers.onError] server error frames.
 * @param {(frame:object) => void} [handlers.onHeartbeat] ping/pong frames.
 * @param {(frame:object) => void} [handlers.onPresence] typing/presence/read frames.
 * @param {(frame:object, kind:string) => void} [handlers.onUnknown] unrecognized frames.
 * @param {(type:string) => void} [handlers.onFrameType]
 *        Observability hook fired for every frame with its raw `type` (mirrors
 *        the original `recordFrameType`). Never throws through the dispatcher.
 * @param {{log?:Function, warn?:Function}} [logger]
 * @returns {(frame:object) => void} onFrame
 */
export function createFrameDispatcher(handlers = {}, logger = {}) {
  const log  = logger.log  || (() => {});
  const warn = logger.warn || (() => {});
  const {
    onMessage, onSystem, onMessageAck, onError,
    onHeartbeat, onPresence, onUnknown, onFrameType,
  } = handlers;

  const guard = (p, label) => {
    if (p && typeof p.then === 'function') {
      p.catch(e => warn(`${label}:`, e?.message || e));
    }
  };

  return function onFrame(frame) {
    if (!frame || typeof frame !== 'object') return;
    if (onFrameType) { try { onFrameType(frame.type); } catch { /* observability must never break dispatch */ } }

    const kind = classifyFrame(frame);
    switch (kind) {
      case FRAME_KIND.MESSAGE:
        if (onMessage) guard(onMessage(frame), 'onMessage');
        break;
      case FRAME_KIND.MESSAGE_ACK:
        log(`message_ack seq=${frame.payload?.seq} msg=${frame.payload?.message_id}`);
        if (onMessageAck) onMessageAck(frame);
        break;
      case FRAME_KIND.SYSTEM: {
        const sysKind = classifySystemEvent(frame.payload?.event);
        log(`system event=${frame.payload?.event || '<unknown>'} conv=${frame.payload?.conversation_id || '<unknown>'} kind=${sysKind || '<ignored>'}`);
        if (onSystem) guard(onSystem(frame, sysKind), 'onSystem');
        break;
      }
      case FRAME_KIND.ERROR:
        warn('server error frame:', JSON.stringify(frame.payload || {}));
        if (onError) onError(frame);
        break;
      case FRAME_KIND.HEARTBEAT:
        // transport/ws.js already auto-replied to pings; nothing to do here.
        if (onHeartbeat) onHeartbeat(frame);
        break;
      case FRAME_KIND.PRESENCE:
        if (onPresence) onPresence(frame);
        break;
      default:
        warn('unknown frame type:', frame.type);
        if (onUnknown) onUnknown(frame, kind);
    }
  };
}
