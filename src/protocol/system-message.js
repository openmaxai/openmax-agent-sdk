/**
 * Helpers for platform System Member messages (调度中心 等播报源).
 *
 * A System Member is a trusted, write-only platform broadcast identity
 * (`sender_type=SYSTEM`). It is NOT a human/agent participant, so the dmPolicy /
 * groupPolicy / owner-binding gates that exist to filter human/agent senders
 * must not apply to it — see access-policy `decideInbound`.
 *
 * Wire shape (实测，DM <dm-id> 的 SYSTEM 消息)：
 *   { sender_type: "SYSTEM", type: "TEXT",
 *     content: { content_type: "text", body: { text: "[调度中心] …" } } }
 * 当前部署的系统消息**尚未携带** `metadata.systemEvent`，所以 priority 读取要
 * 容缺省（无 systemEvent → 返回 undefined，调用方按默认 normal 处理）。一旦
 * cws-work / cws-core 按设计透出 metadata，这里即可生效，无需再改。
 *
 * 设计依据：cws-docs/architecture/v0.7-event-delivery-design.md §5 / §6.3。
 *
 * NOTE (extraction): the priority integers below map to the neutral 1/2/3
 * urgent/high/normal scale. In zylos-openmax that scale was consumed by
 * `c4-receive --priority`; here it is returned as a plain number so any runtime
 * adapter can map it to its own delivery-priority mechanism. No C4 coupling.
 */

// metadata.systemEvent.priority(urgent|high|normal) → priority(1|2|3)
const PRIORITY_BY_NAME = { urgent: 1, high: 2, normal: 3 };

/**
 * Whether a message was sent by a platform System Member.
 * Reads both the top-level `sender_type` (real-time WS frames) and the nested
 * `message.sender_type` (get-message detail envelope), so detection is uniform
 * regardless of arrival path.
 */
export function isSystemSender(msg) {
  if (!msg) return false;
  const t = String(msg.sender_type || msg.message?.sender_type || '').toUpperCase();
  return t === 'SYSTEM';
}

/**
 * Delivery priority (1=urgent / 2=high / 3=normal) for a system message,
 * read from `metadata.systemEvent.priority` wherever cws-core surfaces it.
 * Returns `undefined` when the message carries no `systemEvent` (caller then
 * applies its own default, conventionally 3/normal). An unrecognized priority
 * on an otherwise-present systemEvent degrades to 3 (normal).
 */
export function systemEventPriority(msg) {
  const se =
       msg?.content?.metadata?.systemEvent
    || msg?.metadata?.systemEvent
    || msg?.message?.content?.metadata?.systemEvent;
  if (!se) return undefined;
  return PRIORITY_BY_NAME[String(se.priority || '').toLowerCase()] || 3;
}
