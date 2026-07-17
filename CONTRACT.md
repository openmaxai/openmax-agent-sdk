# The cws-comm protocol contract (canonical source of truth)

This document scopes what `@openmaxai/openmax-agent-sdk` **is** versus what the
**canonical, language-neutral protocol contract** is, and points at the contract
artifacts that pin it down.

## What this package is

`@openmaxai/openmax-agent-sdk` is a **Node.js / ESM implementation** of the
cws-comm agent protocol. It is the runtime SDK that Node adapters
(Claude Code, Codex, OpenClaw) import. It is **not** the cross-language source of
truth: its JS shapes (the normalized `InboundMessage`, the `deliver()` result,
frame classifications, close-code handling, sync/ledger semantics) are *one
conformant implementation* of the protocol, expressed in JavaScript.

A runtime in another language (e.g. a Python / **Hermes** SDK) will **not**
depend on this npm package. It re-implements the same wire protocol and proves
conformance by passing the **same** golden fixtures against the **same** schemas
described below.

## The canonical contract (delivered — this is it)

The protocol is captured here as a **versioned, language-neutral contract**. It
ships in the npm tarball (see `package.json#files`) so any consumer — Node or not
— has the authoritative schemas and fixtures.

### 1. Versioned JSON Schema — `schemas/v1/` (draft 2020-12)

Each file carries a `$id` and a `version`.

| File | Surface |
|------|---------|
| `frame.schema.json` | Top-level inbound WS frame envelope (`type`, `payload`) + the classification enum (`FrameKind`: message / message_ack / system / error / heartbeat / presence / unknown) and the known payload shapes. |
| `inbound-message.schema.json` | The normalized `InboundMessage` the orchestrator hands to `InboundDelivery.deliver` (text/type/attachments/endpoint/priority/decision + the raw merged `message`). `additionalProperties:false` — a drift alarm on new fields. |
| `wake-request.schema.json` | The `raft-channel-wake.v1` request (`{schema, messageId, conversationId, senderId, contentPreview}`). |
| `wake-result.schema.json` | The `deliver()` / `POST /wake` response: `{ok:true, runtimeSession?}` \| `{ok:false, failureClass, retryAfterMs?}`, including the `ok:true ⇔ "genuinely entered the runtime context"` invariant. |
| `failure-class.schema.json` | The enumerated `failureClass` values and their retry semantics. |
| `auth-lifecycle.md` | The ws-ticket / bearer / JWT-refresh flow and the 4001–4006 close-code state machine (a behavioral state machine, so a doc rather than a data shape). |

### 2. Shared golden conformance fixtures — `fixtures/v1/`

A language-neutral corpus of `{input, expected}` JSON files:

- `frame-classification/` — raw frames → expected `FrameKind`.
- `system-event-classification/` — system `event` names → recall/edit/config_update/connection/channel/null.
- `inbound-message/` — raw CWS frame (+ the message-detail and conversation the SDK would fetch) → expected normalized `InboundMessage` fields.
- `wake-request/` — sample `/wake` requests (valid + drift negatives) → `expectValid`.
- `wake-result/` — sample results, `ok` and `ok:false` with `failureClass`/`retryAfterMs` (valid + drift negatives) → `expectValid`.

**Passing this corpus is the definition of "protocol-conformant" for any SDK, in
any language.** The JS SDK proves it in `test/contract.test.js`: it feeds each
fixture input through the REAL SDK code (`classifyFrame` / `classifySystemEvent`
/ the full `CwsAgentBridge` inbound pipeline), asserts the output equals
`expected`, AND validates the SDK-produced output against the schema. A future
Python/Hermes harness runs the identical fixtures the same way. If either
implementation drifts from the contract, its harness fails.

### 3. Contract versioning

The contract is versioned independently of this npm package (`schemas/v1/`,
`fixtures/v1/`; each schema also carries a `version` field). A Node SDK and a
Python SDK can independently state which contract version they implement.

## Known looseness (flagged, not hidden)

- **`failureClass` is an open string in the JS code.** The orchestrator logs and
  re-throws whatever an adapter's `deliver()` returns; only the SDK's own default
  delivery emits a fixed value (`no_inbound_provider`). `failure-class.schema.json`
  enumerates the classes actually present in the codebase
  (`no_inbound_provider`, `wake_failed`) and **designates them canonical** — a new
  class is a contract revision, not an ad-hoc string. The `wake-result`
  drift-negative fixtures assert that an unenumerated class is rejected.
- **`conversationType` / message `type` are server-driven strings.** The schema
  keeps them as free strings (documenting the known values dm/group/thread)
  rather than a closed enum, because the value is whatever cws-core sets on the
  conversation/message.
- **`wake-request` is adapter-built, not SDK-built.** The SDK never constructs the
  `/wake` body (Cat.B delivery lives behind `InboundDelivery.deliver` in the
  adapter). The schema pins the contract both sides must agree on; it is derived
  from the fields the normalized `InboundMessage` carries.

## Interim reference (still useful, now secondary)

The design doc (module map, cut line, wake contract, migration phasing), the
JSDoc typedefs in `src/providers.js`, and the header block of
`src/orchestrator.js` remain a useful narrative reference — but `schemas/v1/` +
`fixtures/v1/` are the authoritative contract.
