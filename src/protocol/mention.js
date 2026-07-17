/**
 * Outbound @-mention canonicalization registry.
 *
 * cws-fe highlights a mention purely client-side: it scans a message's text for
 * `@<participant display_name>` and wraps matches in a highlight chip
 * (`renderTextWithMentions` in cws-fe message-bubble.tsx). There is NO structured
 * mention token, no member_id in the body, and no backend mention storage — the
 * contract is simply "the text contains `@` immediately followed by the exact
 * display_name of a conversation participant".
 *
 * To make the agent's outbound mentions land on that contract we:
 *   1. record the display names we see in each conversation (from inbound
 *      senders / group-context), and
 *   2. on send, canonicalize any `@name` token in the outbound text to the exact
 *      recorded display_name (case/spacing-tolerant match → canonical form) so
 *      cws-fe's participant-name matcher hits.
 *
 * This is a PLATFORM-level contract (it encodes how cws-fe renders mentions), not
 * a runtime-specific concern — all four *-openmax adapters need identical logic,
 * so it lives in the SDK (issue #8). One implementation + golden fixtures beats
 * four copies drifting apart.
 *
 * Extraction notes (ported from zylos-openmax src/lib/mention.js):
 *   - The hard-coded `fs` + `~/zylos/.../mention-registry.json` path is replaced
 *     by the injected StorageProvider (`get(key)` / `set(key, value)`, string
 *     values). The adapter maps `key` to a concrete path. Because the provider is
 *     async, `recordParticipants()` and `resolveMentions()` are now async.
 *   - The rewrite algorithm is unchanged: longest-name-first, case-insensitive
 *     `@name` → canonical `@<exact display_name>`; unknown `@handles` untouched.
 *   - The per-conversation name set keeps the same MAX_NAMES_PER_CONV cap
 *     (oldest-insertion-order eviction) so a busy group can't grow unbounded.
 */

import { memoryStorage } from '../providers.js';

// Bound the per-conversation name set so a busy group can't grow the state
// unbounded. LRU-ish: cap the number of distinct names retained (oldest dropped).
const MAX_NAMES_PER_CONV = 200;

const norm = (s) => String(s ?? '').trim().toLowerCase();

/**
 * Create a per-conversation @mention canonicalization registry backed by a
 * StorageProvider.
 *
 * State schema (persisted under `key`, default `mention-registry.json`):
 *   { [conversationId]: { [normalizedName]: exactDisplayName } }
 *
 * @param {object} [opts]
 * @param {import('../providers.js').StorageProvider} [opts.storage] StorageProvider (default in-memory).
 * @param {string} [opts.key] storage key (default `mention-registry.json`).
 * @param {number} [opts.maxNamesPerConv] per-conversation name cap (default 200).
 * @param {(...args:any[])=>void} [opts.log] best-effort log sink.
 * @returns {{recordParticipants:(conversationId:string, names:string|string[])=>Promise<void>, resolveMentions:(text:string, conversationId:string)=>Promise<string>}}
 */
export function createMentionRegistry({
  storage = memoryStorage(),
  key = 'mention-registry.json',
  maxNamesPerConv = MAX_NAMES_PER_CONV,
  log = () => {},
} = {}) {
  // Lazy in-memory cache of the whole registry (single-process orchestrator).
  // Mirrors the original's load-on-use but avoids a storage read per call;
  // writes are write-through so a restart resumes from the persisted state.
  let cache = null;

  async function ensureLoaded() {
    if (cache) return cache;
    try {
      const raw = await storage.get(key);
      cache = raw ? JSON.parse(raw) : {};
    } catch {
      // Missing or corrupt — start fresh; a read failure must never break
      // message handling.
      cache = {};
    }
    return cache;
  }

  async function persist(reg) {
    try {
      await storage.set(key, JSON.stringify(reg));
    } catch (err) {
      // Best-effort: a write failure must never break message handling.
      log(`mention-registry persist failed: ${err?.message || err}`);
    }
  }

  /**
   * Record one or more participant display names seen in a conversation.
   * @param {string} conversationId
   * @param {string|string[]} names
   */
  async function recordParticipants(conversationId, names) {
    if (!conversationId) return;
    const list = (Array.isArray(names) ? names : [names])
      .map((n) => String(n ?? '').trim())
      .filter(Boolean);
    if (!list.length) return;

    const reg = await ensureLoaded();
    const conv = reg[conversationId] || (reg[conversationId] = {});
    let changed = false;
    for (const name of list) {
      const nkey = norm(name);
      if (conv[nkey] !== name) {
        conv[nkey] = name;
        changed = true;
      }
    }
    if (!changed) return;

    // Cap retained names (drop oldest insertion order).
    const keys = Object.keys(conv);
    if (keys.length > maxNamesPerConv) {
      for (const k of keys.slice(0, keys.length - maxNamesPerConv)) delete conv[k];
    }
    await persist(reg);
  }

  /**
   * Canonicalize `@name` tokens in outbound text to the exact recorded display
   * name for the conversation, so cws-fe's participant-name matcher highlights
   * them. Only rewrites mentions that match a known participant; leaves all other
   * text (including unknown `@handles`) untouched.
   *
   * @param {string} text
   * @param {string} conversationId
   * @returns {Promise<string>}
   */
  async function resolveMentions(text, conversationId) {
    if (!text || !conversationId || !String(text).includes('@')) return text;
    const reg = await ensureLoaded();
    const conv = reg[conversationId];
    if (!conv) return text;

    // Match cws-fe's strategy: try known names longest-first so a longer name
    // (e.g. "Alice Wong") wins over a shorter prefix ("Alice"). Names may contain
    // spaces, so we match the full display_name case-insensitively after an `@`.
    const namesList = Object.values(conv).sort((a, b) => b.length - a.length);
    let out = String(text);
    for (const name of namesList) {
      const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // `@` + the name (case-insensitive); rewrite to the canonical `@<exact>`.
      out = out.replace(new RegExp('@' + esc, 'gi'), '@' + name);
    }
    return out;
  }

  return { recordParticipants, resolveMentions };
}
