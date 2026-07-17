/**
 * SyncEngine — `/sync` gap catch-up over the cws-comm inbox stream.
 *
 * cws-comm assigns every inbound message a per-user, org-wide monotonic
 * `inbox_seq`. A live WS stream can miss frames across a disconnect, so on
 * reconnect the agent replays the gap by paging `POST /api/v1/sync` from its
 * last cursor. This engine owns ONLY that protocol dance — cursor management,
 * `has_more` paging, the per-sweep cap, cursor persistence, and best-effort
 * ack. It is deliberately message-assembly-free: each recovered event is
 * handed to the supplied `onMessage` handler (which the orchestrator/adapter
 * wires to its real message pipeline). No C4, no formatting, no access policy.
 *
 * Extraction notes (lifted from zylos-openmax `src/comm-bridge.js`):
 *   - `syncMissedEvents` (the reconnect catch-up sweep, SYNC_PAGE_SIZE /
 *     SYNC_MAX_EVENTS, per-org in-flight guard), `initSyncSeq` (first-connect
 *     seek-to-inbox-end), and `ackSync` (`POST /sync/ack`) become methods.
 *   - The module-global `postForOrg` / `apiPath` (from client.js) and the
 *     `config.agent.device_id` / `app_version` reads are replaced by the
 *     injected `CwsHttpClient` and `deviceId` / `appVersion` constructor opts.
 *   - `saveOrgSession(...)` (session.js file write) is replaced by an injected
 *     `saveSession(slug, partial)` callback — session.js is a separate module
 *     (its own extraction milestone); the caller still owns the mutable
 *     `sessionRef` cursor object, exactly as comm-bridge did.
 *   - The inbox ledger (continuous-ack watermark + gap detection) is a separate
 *     module (sync/inbox-ledger.js); the orchestrator wires its `onGapSync` to
 *     `syncMissedEvents` and its `onAck` to `ackSync`, mirroring startOrgWs.
 */

import { consoleLogger } from '../providers.js';

// Cap a single catch-up sweep to avoid pulling an unbounded backlog after a
// very long outage. If there are more than this many events to catch up, the
// rest are pulled on the next reconnect (or a manual `comm.sync` invocation).
export const SYNC_PAGE_SIZE = 100;
export const SYNC_MAX_EVENTS = 2000;

export class SyncEngine {
  /**
   * @param {object} deps
   * @param {import('../transport/http.js').CwsHttpClient} deps.http  cws-core client
   * @param {(ev: {id:string, conversation_id:string, seq:number, _via:'sync'}) => Promise<void>} deps.onMessage
   *        handler fed each recovered event (protocol-only; assembly is the caller's).
   * @param {(slug: string, partial: object) => void} [deps.saveSession]  persist the cursor
   *        (default no-op; the caller may instead read the mutated sessionRef).
   * @param {import('../providers.js').Logger} [deps.logger]
   * @param {string} [deps.deviceId]    X-derived device id sent to /sync + /sync/ack
   * @param {string} [deps.appVersion]  app_version sent to /sync/ack
   * @param {number} [deps.pageSize]    per-page limit (default SYNC_PAGE_SIZE)
   * @param {number} [deps.maxEvents]   per-sweep cap (default SYNC_MAX_EVENTS)
   */
  constructor({
    http,
    onMessage,
    saveSession = () => {},
    logger = consoleLogger,
    deviceId = '',
    appVersion = '',
    pageSize = SYNC_PAGE_SIZE,
    maxEvents = SYNC_MAX_EVENTS,
  } = {}) {
    if (!http) throw new Error('SyncEngine requires a CwsHttpClient (http)');
    if (typeof onMessage !== 'function') throw new Error('SyncEngine requires an onMessage handler');
    this.http = http;
    this.onMessage = onMessage;
    this.saveSession = saveSession;
    this.logger = logger;
    this.deviceId = deviceId;
    this.appVersion = appVersion;
    this.pageSize = pageSize;
    this.maxEvents = maxEvents;
    // Per-org guard so a concurrent reconnect doesn't trigger overlapping syncs.
    this._inFlight = new Set();
  }

  _log(...a) { this.logger?.info?.(...a); }
  _warn(...a) { this.logger?.warn?.(...a); }

  _p(path) { return this.http.apiPath(path); }

  /**
   * Reconnect catch-up: page `/sync` from `sessionRef.sync_seq`, feed each event
   * to onMessage, advance + persist the cursor, then ack the highest seq.
   * No-op on the first-ever connect (sync_seq falsy → nothing to catch up).
   *
   * @param {{org_id:string, slug:string}} orgConfig
   * @param {{sync_seq:number}} sessionRef  mutable cursor holder (mutated in place)
   * @param {number|null} [floorSeq]  gap-sync sweep floor (the inbox-ledger's
   *        durable acked_seq). When supplied, the sweep starts from
   *        min(sessionRef.sync_seq, floorSeq) so a hole BELOW the persisted
   *        cursor is re-pulled (issue #5). Omitted/null on the reconnect
   *        catch-up path → sweeps from the cursor exactly as before.
   */
  async syncMissedEvents(orgConfig, sessionRef, floorSeq = null) {
    if (!sessionRef.sync_seq) return; // first-ever connect → nothing to catch up
    if (this._inFlight.has(orgConfig.slug)) {
      this._log(`[${orgConfig.slug}] sync already in flight, skipping`);
      return;
    }
    this._inFlight.add(orgConfig.slug);
    try {
      const cursorSeq = sessionRef.sync_seq;
      // #5: floor the sweep at the ledger's durable acked_seq when provided. The
      // sync cursor can legitimately run AHEAD of the delivery watermark (a live
      // delivery advanced the cursor via a concurrent sweep, then FAILED, so the
      // ledger never recorded that seq). Sweeping from min(cursor, ack) re-pulls
      // that hole; replays at/under the cursor are rejected by ledger.has(), so
      // the lower floor never double-delivers.
      const startSeq = (typeof floorSeq === 'number' && floorSeq >= 0)
        ? Math.min(cursorSeq, floorSeq)
        : cursorSeq;
      let sinceSeq = startSeq;
      let totalSynced = 0;
      let hasMore = true;

      while (hasMore && totalSynced < this.maxEvents) {
        const res = await this.http.postForOrg(orgConfig.org_id, this._p('/sync'), {
          since_seq: sinceSeq,
          device_id: this.deviceId,
          limit: this.pageSize,
        });
        const events = Array.isArray(res?.events) ? res.events : [];
        hasMore = res?.has_more === true;
        if (events.length === 0) break;

        for (const ev of events) {
          if (!ev?.message_id || !ev.conversation_id) continue;
          await this.onMessage({
            id: String(ev.message_id),
            conversation_id: ev.conversation_id,
            seq: ev.seq,
            _via: 'sync',
          });
          if (typeof ev.seq === 'number' && ev.seq > sinceSeq) sinceSeq = ev.seq;
        }
        totalSynced += events.length;
      }

      // Persist the sync cursor (inbox seq) so the next reconnect resumes here.
      // Never rewind: a lower gap-sync floor must not move the durable cursor
      // backwards (seqs above the floor stay consumed — deduped on any replay).
      const newCursor = Math.max(cursorSeq, sinceSeq);
      if (newCursor > cursorSeq) {
        sessionRef.sync_seq = newCursor;
        this.saveSession(orgConfig.slug, { sync_seq: newCursor });
      }

      if (totalSynced > 0) {
        this._log(`[${orgConfig.slug}] sync caught up ${totalSynced} event(s) since seq=${startSeq}, new sync_seq=${sessionRef.sync_seq}` +
          (hasMore && totalSynced >= this.maxEvents ? ` (hit per-sweep cap, more on next reconnect)` : ''));
      }
      // Ack the highest processed seq to cws-comm (best-effort).
      if (sinceSeq > 0) await this.ackSync(orgConfig, sinceSeq);
    } catch (err) {
      this._warn(`[${orgConfig.slug}] sync failed: ${err.message} — will retry on next reconnect`);
    } finally {
      this._inFlight.delete(orgConfig.slug);
    }
  }

  /**
   * First-connect cursor init: on the first-ever connect (sync_seq=0), seek to
   * the END of the inbox so later reconnects only catch up events that arrive
   * after this point. Pages through the whole inbox discarding events to find
   * the max cursor — a one-time cost per new bot that avoids pulling full
   * history later. Persists the resolved cursor.
   *
   * @param {{org_id:string, slug:string}} orgConfig
   * @param {{sync_seq:number}} sessionRef  mutated in place
   */
  async initSyncSeq(orgConfig, sessionRef) {
    try {
      let cursor = 0;
      let hasMore = true;
      while (hasMore) {
        const res = await this.http.postForOrg(orgConfig.org_id, this._p('/sync'), {
          since_seq: cursor,
          device_id: this.deviceId,
          limit: this.pageSize,
        });
        const events = Array.isArray(res?.events) ? res.events : [];
        hasMore = res?.has_more === true;
        if (events.length > 0) {
          cursor = Number(res?.next_cursor) || events[events.length - 1].seq;
        } else {
          break;
        }
      }
      if (cursor > 0) {
        sessionRef.sync_seq = cursor;
        this.saveSession(orgConfig.slug, { org_id: orgConfig.org_id, sync_seq: cursor });
        this._log(`[${orgConfig.slug}] init sync_seq=${cursor} (seeked to inbox end)`);
      }
    } catch (err) {
      this._warn(`[${orgConfig.slug}] initSyncSeq failed: ${err.message}`);
    }
  }

  /**
   * Tell cws-comm how far we've consumed (best-effort; never throws).
   * @param {{org_id:string, slug:string}} orgConfig
   * @param {number} seq  highest contiguously-consumed inbox seq
   */
  async ackSync(orgConfig, seq) {
    try {
      await this.http.postForOrg(orgConfig.org_id, this._p('/sync/ack'), {
        device_id: this.deviceId,
        seq,
        platform: 'agent',
        app_version: this.appVersion,
      });
      this._log(`[${orgConfig.slug}] ack sync_seq=${seq}`);
    } catch (err) {
      this._warn(`[${orgConfig.slug}] ackSync failed: ${err.message}`);
    }
  }
}
