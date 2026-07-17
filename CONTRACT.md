# The cws-comm protocol contract (scope + plan)

This document scopes what `@openmaxai/openmax-agent-sdk` **is** versus what the
**canonical protocol contract** will be, and records the plan for capturing that
contract when the first non-Node runtime lands.

## What this package is

`@openmaxai/openmax-agent-sdk` is a **Node.js / ESM implementation** of the
cws-comm agent protocol. It is the runtime SDK that Node adapters
(Claude Code, Codex, OpenClaw) import. It is **not** the cross-language source of
truth: its JS shapes (the normalized `InboundMessage`, the `deliver()` result,
frame classifications, close-code handling, sync/ledger semantics) are *one
conformant implementation* of the protocol, expressed in JavaScript.

A runtime in another language (e.g. a Python / **Hermes** SDK) will **not**
depend on this npm package. It will re-implement the same wire protocol. For
those runtimes and this one to interoperate, the protocol must be pinned down in
a language-neutral form — that is the contract below, which does **not exist yet**
and is intentionally **not built in this milestone**.

## The canonical contract (planned — not built yet)

When the Python/Hermes SDK work starts, the protocol will be captured as a
**versioned, language-neutral contract**, consisting of:

1. **Versioned JSON Schema** for each protocol surface:
   - **frame** — the top-level WS frame envelope (`type`, `payload`) and its
     kinds (`message`, `message_ack`, `system`, `error`, `ping`/`pong`,
     presence).
   - **inbound-message** — the normalized message shape delivered into a runtime
     (the neutral form of what `orchestrator.js` builds today).
   - **wake-result** — the `deliver()` / `POST /wake` response
     (`{ ok, runtimeSession?, failureClass?, retryAfterMs? }`), including the
     `ok:true` ⇔ "genuinely entered the runtime context" invariant.
   - **failure-class** — the enumerated `failureClass` values and their
     retry/ownership semantics.
   - **auth-lifecycle** — ws-ticket minting, JWT refresh, and the 4001–4006
     close-code state machine.

2. **Shared golden conformance fixtures** — a language-neutral corpus of
   sample frames and expected normalized outputs / decisions, plus **matching
   Node and Python conformance test harnesses** that both run the same fixtures.
   Passing the golden suite is the definition of "protocol-conformant" for any
   SDK, in any language.

3. **Semantic versioning of the contract**, decoupled from this npm package's
   version, so a Node SDK and a Python SDK can independently state which contract
   version they implement.

## Interim reference

Until the schemas + golden fixtures exist, the **design doc** (the module map,
cut line, wake contract, and migration phasing referenced from the README) plus
the JSDoc typedefs in `src/providers.js` and the header block of
`src/orchestrator.js` are the interim reference for the protocol shapes.

## Explicit non-goals for this milestone

- No JSON Schema files are authored here yet.
- No cross-language fixtures or Python harness are built here yet.
- This package does not attempt to be consumable by non-Node runtimes.

This document exists so the scope is unambiguous now and the contract work has a
recorded plan to execute against when the Python/Hermes SDK begins.
