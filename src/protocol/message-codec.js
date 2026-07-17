/**
 * CWS message codec — the neutral, runtime-agnostic parts of the old
 * zylos-openmax `src/lib/message.js`.
 *
 * SCOPE (what belongs in the SDK):
 *   - endpoint parse/construct (the `reply via` routing key: conversation id +
 *     reply/thread/parent suffixes)
 *   - client-side idempotency key generation (client_msg_id)
 *   - outbound-text helpers that are pure protocol: markdown auto-detection,
 *     `[MEDIA:...]` prefix parsing, and length-based chunk splitting.
 *
 * LEFT BEHIND FOR THE RUNTIME ADAPTER (deliberately NOT ported):
 *   - `formatInboundForC4(...)` and its private helpers `escapeXml`,
 *     `formatContextLine`, and the `TYPE_TAG` map. That function shapes an
 *     inbound message into the C4/Zylos XML envelope (`<current-message>`,
 *     `<group-context>`, `[COCO GROUP:name]`, ` ---- image: <path>` …). The
 *     framing is specific to how the Zylos C4 runtime feeds context to its LLM;
 *     every other runtime formats context differently. It also pulls in
 *     `work-reference.js` (proj://issue:// → XML block), which is likewise a
 *     context-presentation concern. All of that stays in the adapter.
 *
 * Endpoint format (routing key / `reply via` target):
 *   <conversationId>
 *   <conversationId>|reply:<messageId>
 *   <conversationId>|thread:<threadConvId>|parent:<parentMsgId>
 *
 * The conversation type ([COCO DM]/[COCO GROUP]/[COCO THREAD]) is NOT part of
 * the target: routing is driven purely by the conversation id plus the
 * reply/thread/parent suffixes. `parseEndpoint` still accepts the legacy
 * `[COCO TYPE]/<id>...` form for backward compatibility (in-flight messages,
 * older callers), but `formatEndpoint` emits the minimal form.
 */

import { randomUUID } from 'crypto';

/**
 * Generate a client-side idempotency key for SendMessageRequest.client_msg_id.
 * The server de-dupes identical client_msg_id within 5 minutes (api-design.md §5.1).
 */
export function newClientMsgId() {
  return `c_${randomUUID()}`;
}

/**
 * Parse an endpoint string into structured fields.
 *
 * Accepts two forms:
 *   - minimal (current):  `<conversationId>[|reply:..][|thread:..][|parent:..]`
 *   - legacy:             `[COCO TYPE]/<conversationId>[|...]`  (prefix stripped)
 *
 * The leading conversation id is whatever precedes the first `|`. The type
 * prefix, if present, is informational only — routing is driven entirely by
 * the conversation id and the reply/thread/parent suffixes.
 *
 * @param {string} endpoint
 * @returns {{type:string, conversationId:string, replyTo?:string,
 *            threadConversationId?:string, parentMessageId?:string}}
 */
export function parseEndpoint(endpoint) {
  let rest = (endpoint || '').trim();

  // Strip the legacy `[COCO TYPE]/` prefix if present (back-compat).
  let typeHint = null;
  const legacy = /^\[COCO (DM|GROUP|THREAD)\]\/(.*)$/.exec(rest);
  if (legacy) { typeHint = legacy[1].toLowerCase(); rest = legacy[2]; }

  const segments = rest.split('|');
  const conversationId = (segments.shift() || '').trim();
  if (!conversationId) throw new Error(`invalid endpoint: ${endpoint}`);

  const result = { conversationId };
  for (const part of segments.filter(Boolean)) {
    const idx = part.indexOf(':');
    if (idx === -1) continue;
    const k = part.slice(0, idx);
    const v = part.slice(idx + 1);
    if (k === 'reply')  result.replyTo = v;
    else if (k === 'thread') result.threadConversationId = v;
    else if (k === 'parent') result.parentMessageId = v;
  }
  // `type` is retained for callers that inspect it, but is not used for
  // routing. Prefer the legacy hint; otherwise infer from the suffixes.
  result.type = typeHint || (result.threadConversationId ? 'thread' : 'dm');
  return result;
}

/**
 * Build an endpoint string (the `reply via` target) from structured fields.
 *
 * Emits the minimal form — conversation id plus reply/thread/parent suffixes.
 * The conversation type is intentionally omitted (see parseEndpoint): it was
 * never consulted by the send path. `ep.type` is accepted but ignored.
 *
 * @param {{type?:string, conversationId:string, replyTo?:string,
 *          threadConversationId?:string, parentMessageId?:string}} ep
 */
export function formatEndpoint(ep) {
  if (!ep?.conversationId) throw new Error('formatEndpoint: conversationId required');
  let s = `${ep.conversationId}`;
  if (ep.replyTo)              s += `|reply:${ep.replyTo}`;
  if (ep.threadConversationId) s += `|thread:${ep.threadConversationId}`;
  if (ep.parentMessageId)      s += `|parent:${ep.parentMessageId}`;
  return s;
}

/**
 * Heuristic markdown auto-detection for outbound messages.
 * Matches presence of headings, emphasis, code fences, lists, or links.
 */
export function looksLikeMarkdown(text) {
  if (typeof text !== 'string' || !text) return false;
  return /(^|\n)(#{1,6}\s|[*_-]{1,3}\s|```|\|\s|>\s|\d+\.\s)/.test(text) ||
         /\[[^\]]+\]\([^)]+\)/.test(text) ||
         /\*\*\S/.test(text) ||
         /`[^`]+`/.test(text);
}

/**
 * MEDIA prefix detection for outbound messages.
 * Matches `[MEDIA:image]/path/to/file` or `[MEDIA:file]/path/to/doc.pdf`.
 */
export function parseMediaPrefix(message) {
  // First line after the tag is the file path (may contain spaces); anything
  // after the first newline is an optional caption that travels with the media
  // message (cws-fe puts it in content.body.text). Path-only messages (no
  // newline) keep working unchanged.
  const m = /^\[MEDIA:(image|file)\]([^\n]*)(?:\n([\s\S]*))?$/.exec(message || '');
  if (!m) return null;
  const caption = m[3] != null ? m[3].trim() : '';
  return { kind: m[1], localPath: m[2].trim(), caption: caption || undefined };
}

/**
 * Split a long message into chunks that fit within maxLen characters.
 * Tries to break at paragraph (double-newline) boundaries first, then
 * single-newline boundaries, then hard-cuts as a last resort.
 */
export function splitMessage(text, maxLen = 3000) {
  if (!text || text.length <= maxLen) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    let cut = -1;

    // prefer paragraph break
    cut = remaining.lastIndexOf('\n\n', maxLen);
    if (cut > maxLen * 0.4) { chunks.push(remaining.slice(0, cut).trimEnd()); remaining = remaining.slice(cut).trimStart(); continue; }

    // fallback: single newline
    cut = remaining.lastIndexOf('\n', maxLen);
    if (cut > maxLen * 0.4) { chunks.push(remaining.slice(0, cut).trimEnd()); remaining = remaining.slice(cut + 1).trimStart(); continue; }

    // last resort: hard cut at maxLen
    chunks.push(remaining.slice(0, maxLen));
    remaining = remaining.slice(maxLen);
  }

  if (remaining.trim()) chunks.push(remaining.trim());
  return chunks;
}
