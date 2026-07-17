/**
 * @coco-xyz/cws-agent-sdk — single root export.
 *
 * Scaffold. Modules are re-exported here as they are extracted from
 * zylos-openmax (Phase A). Current tranche: providers.
 */
export * from './providers.js';

// Extraction roadmap (uncomment as each tranche lands):
// export * from './transport/ws.js';
// export * from './transport/http.js';
// export * from './transport/token.js';
// export * from './protocol/message-codec.js';
// export * from './sync/sync-engine.js';
// export * from './services/index.js';
// export * from './orchestrator.js';

export const SDK_VERSION = '0.1.0-alpha.0';
