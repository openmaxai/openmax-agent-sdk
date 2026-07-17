# @coco-xyz/cws-agent-sdk

CWS agent runtime SDK — the **cws-comm protocol layer** extracted from `zylos-openmax`, so any agent runtime (Claude Code, Codex, OpenClaw, Hermes, …) can connect to COCO Workspace without depending on Zylos internals.

> Design: `协议归协议、runtime 归 runtime`. This package is **Layer 1** (shared protocol). Runtime-specific bridging lives in thin **Layer 2** adapter repos (`*-openmax`) that import this SDK. Mirrors the `@coco-xyz/hxa-connect-sdk` + adapter precedent.

## Scope

**In the SDK** (generic CWS + agent-level concerns):

- **transport/** — `WsClient` (auth, heartbeat, client keepalive-ping + frame-watchdog, exponential-backoff reconnect, 4001–4006 close-code handling), HTTP client (native `fetch` + auth), CF-Access headers, token/identity management.
- **protocol/** — frame dispatch, message codec (CWS message ↔ neutral shape), access policy, system-message handling.
- **sync/** — `SyncEngine` (`/sync` gap catch-up) + inbox-ledger (dedup + contiguous ack).
- **services/** — `tm` / `kb` / `as` / `comm` / `core` / `conn` service clients over the cws-core REST API.
- **reporters/** — agent-level online-report + runtime metrics (+ cgroup resources, billing status). *(No channel-liveness — that is Zylos-specific, see below.)*
- **identity/** — agent-domain resolution, self-name hydration.
- **orchestrator.js** — a single instantiable class that wires the above (the protocol orchestration currently inlined in `comm-bridge.js`).
- **providers.js** — injection interfaces so the SDK never touches a runtime's filesystem/process manager directly.

**NOT in the SDK** (Zylos/openmax adapter-only, owner decision 2026-07-17):

- **channel-liveness** — enumerating the 13 IM-channel components' pm2 status. Not done here at all.
- **the 13 IM channels** — install / management / connection (`channel-connector`), which are coupled to pm2 + the `zylos` CLI.

These stay entirely inside the `zylos-openmax` adapter.

## Providers (dependency injection)

The SDK is environment-agnostic. A runtime adapter supplies:

- `StorageProvider` — read/write config + cached credentials (no hard-coded `~/zylos` paths).
- `RuntimeStateProvider` — runtime metrics/state for the online + metrics reporters.
- `InboundDelivery` — the core translation point: deliver an inbound CWS message into the runtime's context (Cat.A native channel, or Cat.B `/wake`).
- `Logger` — structured logging sink.

Each provider has a safe no-op/degraded default.

## Language

Plain **JavaScript / ESM**, no build step (matches `zylos-openmax`; owner decision 2026-07-17 — TS and JS are runtime-identical). Optional hand-written `types/*.d.ts` may be added later for consumer type hints without adopting a TS build.

## Status

`0.1.0-alpha.0` — scaffold. Extraction in progress (Phase A). See the design doc for the full module map, cut line, wake contract, and migration phasing.
