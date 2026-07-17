/**
 * @coco-xyz/cws-agent-sdk — single root export.
 *
 * Scaffold. Modules are re-exported here as they are extracted from
 * zylos-openmax (Phase A). Current tranche: providers.
 */
export * from './providers.js';

// ── transport layer (Phase A · milestone 1) ─────────────────────────────────
// WS client (keepalive-ping + frame-watchdog + backoff reconnect), HTTP client,
// token manager, and Cloudflare-Access headers.
export * from './transport/ws.js';          // WsClient, createDeduper
export * from './transport/http.js';         // CwsHttpClient
export * from './transport/token.js';        // TokenManager
export * from './transport/cf-access.js';    // cfAccessHeaders

// ── protocol layer (Phase A · milestone 2) ──────────────────────────────────
// Runtime-agnostic CWS protocol: message codec (endpoint parse/format, media
// prefix, markdown detect, split), frame classification/dispatch, DM/group
// access-policy engine, and system-message helpers. Runtime-specific formatting
// (e.g. the C4 `formatInboundForC4` XML envelope) is intentionally NOT here —
// it stays in the adapter.
export * from './protocol/message-codec.js';   // newClientMsgId, parseEndpoint, formatEndpoint, looksLikeMarkdown, parseMediaPrefix, splitMessage
export * from './protocol/frame-dispatch.js';  // classifyFrame, classifySystemEvent, createFrameDispatcher, FRAME_KIND
export * from './protocol/access-policy.js';   // decideInbound, isSiblingAgentSender, extractMentions, isSelfNameMentionedInText, notices, VALID_* sets
export * from './protocol/system-message.js';  // isSystemSender, systemEventPriority

// ── service clients (Phase A · milestone 3) ─────────────────────────────────
// Programmatic REST clients for the cws-core surface (tm/kb/as/comm/core/conn),
// each taking the shared CwsHttpClient. Extracted from zylos-openmax
// src/cli/*.js; the argv/stdout CLI shell stays in the runtime adapter.
export * from './services/index.js';  // {Tm,Kb,As,Comm,Core,Conn}Service + create* factories

// Extraction roadmap (uncomment as each tranche lands):
// export * from './sync/sync-engine.js';
// export * from './orchestrator.js';

export const SDK_VERSION = '0.1.0-alpha.0';
