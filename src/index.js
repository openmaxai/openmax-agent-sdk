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

// Extraction roadmap (uncomment as each tranche lands):
// export * from './protocol/message-codec.js';
// export * from './sync/sync-engine.js';
// export * from './services/index.js';
// export * from './orchestrator.js';

export const SDK_VERSION = '0.1.0-alpha.0';
