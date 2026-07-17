/**
 * Provider interfaces (dependency injection).
 *
 * The SDK never touches a runtime's filesystem, process manager, or IM layer
 * directly. A runtime adapter supplies these providers; each has a safe
 * degraded default so the SDK is usable (with reduced capability) even when a
 * provider is omitted.
 *
 * These are JSDoc typedefs (plain JS, no TS build). Optional hand-written
 * `types/*.d.ts` can mirror them for consumer autocomplete later.
 */

/**
 * @typedef {Object} StorageProvider
 * Persist/read agent config and cached credentials. Replaces all hard-coded
 * `~/zylos` path access in the extracted code.
 * @property {(key: string) => Promise<string|null>} get   - read a value (null if absent)
 * @property {(key: string, value: string) => Promise<void>} set - write a value
 */

/**
 * @typedef {Object} RuntimeStateProvider
 * Supplies runtime metrics/state for the online + metrics reporters.
 * @property {() => Promise<Object>} getMetrics - {cpu_pct, mem_pct, state, model, ...}
 */

/**
 * @typedef {Object} InboundDelivery
 * The core translation point: deliver an inbound CWS message into the runtime's
 * visible context. Cat.A implementations map to a native channel; Cat.B
 * implementations POST /wake (raft-channel-wake.v1) and MUST only resolve
 * success once the message genuinely entered the runtime context.
 * @property {(msg: Object) => Promise<{ok: boolean, runtimeSession?: string, failureClass?: string, retryAfterMs?: number}>} deliver
 */

/**
 * @typedef {Object} Logger
 * Structured logging sink.
 * @property {(...args: any[]) => void} info
 * @property {(...args: any[]) => void} warn
 * @property {(...args: any[]) => void} error
 * @property {(...args: any[]) => void} [debug]
 */

/** Safe no-op logger (default). */
export const consoleLogger = {
  info: (...a) => console.log(...a),
  warn: (...a) => console.warn(...a),
  error: (...a) => console.error(...a),
  debug: () => {},
};

/** In-memory StorageProvider (default; non-persistent — adapters should override). */
export function memoryStorage() {
  const m = new Map();
  return {
    async get(k) { return m.has(k) ? m.get(k) : null; },
    async set(k, v) { m.set(k, v); },
  };
}

/**
 * Normalize a partial provider bag into a full one with defaults filled in.
 * @param {{storage?: StorageProvider, runtimeState?: RuntimeStateProvider, inbound?: InboundDelivery, logger?: Logger}} [p]
 */
export function resolveProviders(p = {}) {
  return {
    storage: p.storage || memoryStorage(),
    runtimeState: p.runtimeState || { async getMetrics() { return {}; } },
    inbound: p.inbound || { async deliver() { return { ok: false, failureClass: 'no_inbound_provider' }; } },
    logger: p.logger || consoleLogger,
  };
}
