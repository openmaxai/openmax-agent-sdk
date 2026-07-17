// =============================================================================
// Cloudflare Access service-token headers.
//
// Some environments sit behind Cloudflare Access, which requires a
// CF-Access-Client-Id / CF-Access-Client-Secret service-token pair on every
// outbound REST call and the WebSocket handshake. These are NOT a cws-core auth
// credential — they only let traffic through the Access gate.
//
// The values come from operator-supplied env (COCO_CF_ACCESS_CLIENT_ID /
// COCO_CF_ACCESS_CLIENT_SECRET) or from a config object passed by the caller
// (`cfg.cf_access.client_id` / `cfg.cf_access.client_secret`). They are NEVER
// hardcoded here. When both are empty (direct/unprotected environments) no
// CF-Access headers are emitted.
//
// Used by: transport/http.js, transport/token.js, transport/ws.js.
//
// NOTE (extraction): the zylos-openmax source loaded the runtime config via
// `./config.js` (loadConfig()) when no cfg was passed — a ~/zylos-coupled path.
// That coupling is removed here: the SDK reads the CF-Access pair from env, and
// callers that want config.json values pass them in via `cfg`. Env-driven
// deployments (the production path) are unchanged.
// =============================================================================

/**
 * Build the CF-Access header object. Reads env first, then the optional `cfg`.
 * Returns {} when the token pair isn't configured, so callers can spread it
 * unconditionally.
 *
 * @param {{ cf_access?: { client_id?: string, client_secret?: string } }} [cfg]
 */
export function cfAccessHeaders(cfg) {
  const ca = cfg?.cf_access || {};
  const id     = process.env.COCO_CF_ACCESS_CLIENT_ID     || ca.client_id;
  const secret = process.env.COCO_CF_ACCESS_CLIENT_SECRET || ca.client_secret;
  const headers = {};
  if (id)     headers['CF-Access-Client-Id']     = id;
  if (secret) headers['CF-Access-Client-Secret'] = secret;
  return headers;
}
