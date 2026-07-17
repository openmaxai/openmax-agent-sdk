/**
 * Inbox-seq ledger — per-org persistent tracking of received inbox sequences.
 *
 * Maintains a continuous-ack watermark (acked_seq) and a set of received-but-
 * not-yet-contiguous sequences. A periodic timer advances the watermark,
 * triggers ackSync, and detects gaps that need /sync backfill.
 *
 * State schema (persisted via the injected StorageProvider under `key`,
 * default `inbox-{orgSlug}.json`):
 *   { acked_seq: number, received: number[] }
 *
 * Extraction notes (ported from zylos-openmax src/lib/inbox-ledger.js):
 *   - The hard-coded `fs` + `RUNTIME_DIR` file path is replaced by the injected
 *     StorageProvider (`get(key)` / `set(key, value)`, string values). The
 *     adapter maps `key` to a concrete path (zylos → runtime/inbox-{slug}.json).
 *     Because the provider is async, `load()` is now an awaited method (call it
 *     — and await it — before `setAckedSeq()` / `start()`), and the tmp+rename
 *     atomic write moves behind the provider's `set`.
 *   - Timers/thresholds/`now` are injectable so gap detection is deterministic
 *     under test; the production defaults match the original constants.
 */

import { memoryStorage } from '../providers.js';

const TICK_INTERVAL_MS = 5_000;
const GAP_TIMEOUT_MS = 10_000;
const RECEIVED_CAP = 5000;
const PERSIST_DEBOUNCE_MS = 1_000;

export function createInboxLedger(orgSlug, {
  onAck,
  onGapSync,
  log = () => {},
  storage = memoryStorage(),
  key = `inbox-${orgSlug}.json`,
  tickIntervalMs = TICK_INTERVAL_MS,
  gapTimeoutMs = GAP_TIMEOUT_MS,
  receivedCap = RECEIVED_CAP,
  persistDebounceMs = PERSIST_DEBOUNCE_MS,
  now = Date.now,
} = {}) {
  let ackedSeq = 0;
  let lastAckedSeq = 0;
  const received = new Set();
  let oldestGapTs = null;
  let persistTimer = null;
  let tickTimer = null;

  function snapshot() {
    const sorted = [...received].sort((a, b) => a - b);
    return { acked_seq: ackedSeq, received: sorted };
  }

  /**
   * Load persisted state via the StorageProvider. Async (the provider is
   * async); await before setAckedSeq()/start(). Best-effort — a missing or
   * corrupt value starts fresh (ackedSeq is then seeded from sync_seq).
   */
  async function load() {
    try {
      const raw = await storage.get(key);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (typeof data.acked_seq === 'number' && data.acked_seq > 0) {
        ackedSeq = data.acked_seq;
        lastAckedSeq = data.acked_seq;
      }
      if (Array.isArray(data.received)) {
        for (const s of data.received) {
          if (typeof s === 'number' && s > ackedSeq) received.add(s);
        }
      }
      log(`inbox-ledger loaded: acked_seq=${ackedSeq} pending=${received.size}`);
    } catch {
      // No value or corrupt — start fresh; ackedSeq will be set from sync_seq.
    }
  }

  function persist() {
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      const data = snapshot();
      Promise.resolve(storage.set(key, JSON.stringify(data))).catch((err) => {
        log(`inbox-ledger persist failed: ${err.message}`);
      });
    }, persistDebounceMs);
    if (persistTimer.unref) persistTimer.unref();
  }

  function advanceWatermark() {
    let advanced = false;
    while (received.has(ackedSeq + 1)) {
      ackedSeq += 1;
      received.delete(ackedSeq);
      advanced = true;
    }
    if (advanced) {
      oldestGapTs = null;
    }
    return advanced;
  }

  /**
   * Record a received inbox_seq. Returns false if it was already known
   * (duplicate), true if it's new and should be processed.
   */
  function record(inboxSeq) {
    if (typeof inboxSeq !== 'number' || inboxSeq <= 0) return true;
    if (inboxSeq <= ackedSeq) return false;
    if (received.has(inboxSeq)) return false;
    received.add(inboxSeq);
    advanceWatermark();
    persist();
    return true;
  }

  function tick() {
    advanceWatermark();
    if (ackedSeq > lastAckedSeq) {
      lastAckedSeq = ackedSeq;
      persist();
      if (onAck) onAck(ackedSeq);
    }

    if (received.size > 0) {
      if (received.size > receivedCap) {
        log(`inbox-ledger: received set overflow (${received.size}), triggering /sync`);
        received.clear();
        oldestGapTs = null;
        persist();
        if (onGapSync) onGapSync(ackedSeq);
        return;
      }
      if (!oldestGapTs) {
        oldestGapTs = now();
      } else if (now() - oldestGapTs > gapTimeoutMs) {
        log(`inbox-ledger: gap persisted ${Math.round((now() - oldestGapTs) / 1000)}s, triggering /sync from ${ackedSeq}`);
        oldestGapTs = now();
        if (onGapSync) onGapSync(ackedSeq);
      }
    } else {
      oldestGapTs = null;
    }
  }

  function start() {
    if (tickTimer) return;
    tickTimer = setInterval(tick, tickIntervalMs);
    if (tickTimer.unref) tickTimer.unref();
  }

  /**
   * Stop the timers and issue a final best-effort persist. Returns the promise
   * of that final write (callers may await it for a clean shutdown; the
   * original comm-bridge called stop() synchronously and did not).
   */
  function stop() {
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
    return Promise.resolve(storage.set(key, JSON.stringify(snapshot()))).catch(() => {});
  }

  function setAckedSeq(seq) {
    if (typeof seq === 'number' && seq > ackedSeq) {
      ackedSeq = seq;
      lastAckedSeq = seq;
      for (const s of received) {
        if (s <= ackedSeq) received.delete(s);
      }
      persist();
    }
  }

  function getAckedSeq() { return ackedSeq; }

  return { record, start, stop, setAckedSeq, getAckedSeq, load, tick };
}
