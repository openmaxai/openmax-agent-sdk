# Auth & connection lifecycle (contract v1)

This is a **behavioral** contract (a state machine), not a single data shape, so it
is captured as a doc rather than a JSON Schema. It pins the ticket/bearer/
close-code lifecycle every conformant SDK (JS today, Python/Hermes next) must
implement. Faithful to `src/transport/token.js` and `src/transport/ws.js`.

Version: `1.0.0`.

## 1. Token acquisition (cws-core `auth.go`)

All three calls are `POST` to the cws-core base URL. CF-Access headers are added
when configured. Responses may be D8-wrapped (`{data: {...}}`) — unwrap `data`
if present.

| Op | Endpoint | Authorization | Body | Response |
|----|----------|---------------|------|----------|
| **exchange** | `/auth/agent/token` | `Bearer <api_key>` (`cwsk_…`) | `{}` (identity-only) or `{ org_id }` (org-scoped) | `{ access_token, access_token_expires_at, refresh_token, refresh_token_expires_at }` |
| **refresh** | `/auth/refresh` | `Bearer <access_token>` | `{ refresh_token }` or `{ refresh_token, org_id }` | rotated token pair (same shape) |
| **ws-ticket** | `/auth/ws-ticket` | `Bearer <access_token>` (org-scoped JWT required) | `{ org_id }` | `{ ticket, expires_at }` — **~30 s TTL, one-time use** |

Rules:
- **Per-org caching.** Access tokens are bound to a specific `org_id` (or `''` for
  identity-only). Cache keyed by org.
- **Early refresh.** Reuse a cached access token only while
  `access_token_expires_at - now > refreshMarginMs` (default 60 000 ms).
  Otherwise refresh; if refresh fails, fall back to a fresh `exchange` with the
  api_key.
- **Inflight dedup.** Concurrent callers for the same org's token share one
  in-flight request.
- **member_id write-back.** On an org-scoped exchange/refresh, decode the JWT's
  `member_id` (or `mid`) claim (no signature check) and surface it to the adapter
  (`onMemberId(orgId, memberId)`). The SDK does not persist config itself.
- **ws-ticket requires an org.** `getWsTicket` throws if no org_id resolves; it
  first ensures a valid org-scoped access token, then mints the one-time ticket.

## 2. WS connect

Per (re)connect leg the client mints a fresh URL via `urlProvider`:
1. run the self-name hydration barrier (fail-open),
2. mint a one-time ws-ticket,
3. connect to `${wsBaseUrl}?ticket=<urlencoded ticket>`.

Connect headers (`transport/ws.js`): `Authorization: Bearer <token>` (when a
bearer token is set), `X-Workspace-Id`, `X-Device-Id`, `X-Client-Version`, plus
CF-Access headers. If `urlProvider` throws, the connect is retried through the
normal backoff loop (honoring an `err.retryAfterMs` hint if present).

## 3. Heartbeat / frame watchdog

- cws-comm uses **WS-level Ping/Pong** and also JSON `{type:'ping'}`/`{type:'pong'}`
  text frames. The client auto-replies to a JSON `ping` with a JSON `pong`, and
  the `ws` library auto-replies to protocol Pings with Pongs.
- The client sends its **own** WS-level ping every `pingIntervalMs` (default
  20 000 ms) so the watchdog is fed even when server pings do not traverse the
  path.
- **Frame watchdog:** if no frame of any kind arrives within
  `heartbeatIntervalMs * 2 + 5 000 ms` (65 s at defaults), the client
  `terminate()`s to force a reconnect. Any received frame (message, ping, pong)
  advances `lastFrameAt`.

## 4. Reconnect backoff

Exponential: `base * 2^attempt`, capped at `reconnectMaxMs` (default 30 000 ms).
`base` = 1 000 ms normally; for rate-limited closes (4004) `base` = max(8 000,
5 000) = 8 000 ms. `attempt` resets to 0 on a successful open.

## 5. Close-code state machine (cws-comm api-design §4.5)

| Code | Meaning | Action |
|------|---------|--------|
| `1000` / `1001` | normal close | reconnect (backoff) |
| `4001` | heartbeat timeout | reconnect |
| `4002` | auth failed | **terminal — stop this org** (`onFatal`); caller alerts |
| `4003` | session expired | **invalidate the cached token/JWT** for the org (keep `sync_seq`), then reconnect and re-auth with api_key |
| `4004` | rate limited | reconnect with the longer (8 s base) backoff |
| `4005` | workspace suspended | **terminal — stop this org** (`onFatal`) |
| `4006` | duplicate connection | **terminal — stop this org** (`onFatal`) |

Terminal codes = `{4002, 4005, 4006}`: the client sets `stopped=true` and invokes
`onFatal(code, reason)` instead of `onClose`. The orchestrator decrements its live
org count and, when it reaches zero, invokes `onAllOrgsTerminated`. `4003` is
handled in `onClose` by invalidating the token cache while preserving the sync
cursor so catch-up resumes after re-auth. All non-terminal codes reconnect while
`stopped` is false.
