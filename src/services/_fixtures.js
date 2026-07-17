/**
 * Shared test fixtures for the service-client tests. This file is intentionally
 * NOT named `*.test.js` so `node --test` does not execute it directly — it is
 * imported by the per-service test files.
 */
import { CwsHttpClient } from '../transport/http.js';

// Keep tests hermetic regardless of ambient CWS env config.
export function clearCwsEnv() {
  for (const k of ['COCO_API_URL', 'COCO_API_KEY', 'COCO_ORG_ID', 'COCO_USER_TOKEN',
    'COCO_AUTH_TOKEN', 'COCO_API_PREFIX', 'COCO_DEVICE_ID', 'COCO_CLIENT_VERSION',
    'COCO_RPC_LOG', 'COCO_RPC_LOG_FILE']) {
    delete process.env[k];
  }
}

export const quietLogger = { log() {}, warn() {}, error() {} };

/**
 * Fake fetch recording each call and replaying queued responses. Each queued
 * response is `{ status?, json?, text? }`. Recorded calls expose parsed request
 * details via `fetch.requests` (method, url, path, query, body, authorization).
 */
export function fakeFetch(responses) {
  const calls = [];
  const requests = [];
  const queue = [...responses];
  const fn = async (url, opts = {}) => {
    calls.push({ url, opts });
    let body;
    if (opts.body !== undefined) {
      try { body = JSON.parse(opts.body); } catch { body = opts.body; }
    }
    const u = new URL(url);
    const query = {};
    for (const [k, v] of u.searchParams.entries()) {
      if (query[k] === undefined) query[k] = v;
      else if (Array.isArray(query[k])) query[k].push(v);
      else query[k] = [query[k], v];
    }
    requests.push({
      method: opts.method,
      url,
      path: u.pathname,
      query,
      searchParams: u.searchParams,
      body,
      authorization: opts.headers?.Authorization,
      headers: opts.headers || {},
    });
    const next = queue.shift();
    if (!next) throw new Error('fakeFetch: no more queued responses');
    const { status = 200, json, text } = next;
    const bodyText = text !== undefined ? text : JSON.stringify(json);
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: `HTTP ${status}`,
      async text() { return bodyText; },
      async arrayBuffer() { return Buffer.from(bodyText); },
    };
  };
  fn.calls = calls;
  fn.requests = requests;
  return fn;
}

/** A default D8 single-envelope OK response. */
export function ok(data = {}) {
  return { json: { data, request_id: 'test-request' } };
}

/**
 * Build a real CwsHttpClient wired to a fakeFetch that replays `responses`
 * (default: one OK envelope). Returns { http, fetch }.
 */
export function makeClient(responses = [ok()], opts = {}) {
  const fetch = fakeFetch(responses);
  const http = new CwsHttpClient({
    baseUrl: 'http://api.test',
    fetch,
    logger: quietLogger,
    apiKey: opts.apiKey ?? 'test-token',
    ...opts,
  });
  return { http, fetch };
}
