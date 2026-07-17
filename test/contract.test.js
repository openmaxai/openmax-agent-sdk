/**
 * Protocol contract conformance test.
 *
 * This is the drift alarm for @openmaxai/openmax-agent-sdk. It proves that the
 * versioned JSON Schemas in schemas/v1/ and the language-neutral golden fixtures
 * in fixtures/v1/ describe what the JS SDK actually emits/consumes — NOT an
 * aspirational spec. A future Python/Hermes SDK re-runs the SAME fixtures against
 * the SAME schemas; any divergence between an implementation and the contract
 * fails here (in JS) or there (in Python).
 *
 * It does three things:
 *   (a) every schema is itself a valid draft-2020-12 schema (compiles + meta-validates);
 *   (b) every golden fixture input is fed through the REAL SDK code
 *       (classifyFrame / classifySystemEvent / the full CwsAgentBridge inbound
 *       pipeline) and the output is asserted to equal the fixture's `expected`;
 *   (c) the SDK-produced output (and the wake req/result corpora) validate against
 *       the schema — so a shape change in the SDK breaks schema validation here.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import Ajv2020 from 'ajv/dist/2020.js';

import { CwsAgentBridge } from '../src/orchestrator.js';
import { CwsHttpClient } from '../src/transport/http.js';
import { classifyFrame, classifySystemEvent } from '../src/protocol/frame-dispatch.js';

// Keep the inbound-pipeline fixtures hermetic regardless of ambient CWS env.
for (const k of ['COCO_API_URL', 'COCO_API_KEY', 'COCO_ORG_ID', 'COCO_USER_TOKEN',
  'COCO_AUTH_TOKEN', 'COCO_API_PREFIX', 'COCO_DEVICE_ID', 'COCO_CLIENT_VERSION']) {
  delete process.env[k];
}
process.env.COCO_RPC_LOG = '0';   // silence the http client's stdout RPC log

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SCHEMAS_DIR = path.join(ROOT, 'schemas', 'v1');
const FIXTURES_DIR = path.join(ROOT, 'fixtures', 'v1');

const SCHEMA_ID = {
  frame: 'https://schemas.openmax.ai/cws/v1/frame.schema.json',
  inbound: 'https://schemas.openmax.ai/cws/v1/inbound-message.schema.json',
  wakeRequest: 'https://schemas.openmax.ai/cws/v1/wake-request.schema.json',
  wakeResult: 'https://schemas.openmax.ai/cws/v1/wake-result.schema.json',
  failureClass: 'https://schemas.openmax.ai/cws/v1/failure-class.schema.json',
};

// ── helpers ──────────────────────────────────────────────────────────────────
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const listJson = (dir) =>
  fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => path.join(dir, f));
const reEsc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// One Ajv instance holding every contract schema (cross-$ref by $id resolves).
function buildAjv() {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const docs = fs
    .readdirSync(SCHEMAS_DIR)
    .filter((f) => f.endsWith('.schema.json'))
    .map((f) => readJson(path.join(SCHEMAS_DIR, f)));
  for (const doc of docs) ajv.addSchema(doc);
  return { ajv, docs };
}

// ── (a) schemas are themselves valid draft-2020-12 schemas ───────────────────
test('contract: every schema is a valid draft-2020-12 schema and compiles', () => {
  const { ajv, docs } = buildAjv();
  assert.ok(docs.length >= 5, `expected >=5 schema docs, found ${docs.length}`);
  for (const doc of docs) {
    assert.ok(doc.$id, `schema missing $id: ${doc.title || '<untitled>'}`);
    assert.ok(doc.version, `schema missing version: ${doc.$id}`);
    assert.equal(ajv.validateSchema(doc), true, `schema not meta-valid: ${doc.$id}`);
    assert.ok(ajv.getSchema(doc.$id), `schema did not compile: ${doc.$id}`);
  }
});

// ── (b/c) frame classification fixtures ──────────────────────────────────────
test('contract: frame-classification fixtures match classifyFrame() and validate against frame.schema', () => {
  const { ajv } = buildAjv();
  const validateFrame = ajv.getSchema(SCHEMA_ID.frame);
  const files = listJson(path.join(FIXTURES_DIR, 'frame-classification'));
  assert.ok(files.length > 0, 'no frame-classification fixtures found');
  for (const f of files) {
    const fx = readJson(f);
    assert.equal(classifyFrame(fx.input), fx.expected, `classifyFrame mismatch: ${path.basename(f)}`);
    assert.equal(validateFrame(fx.input), true,
      `frame fixture failed schema: ${path.basename(f)} — ${ajv.errorsText(validateFrame.errors)}`);
  }
});

// ── (b) system-event sub-classification fixtures ─────────────────────────────
test('contract: system-event-classification fixtures match classifySystemEvent()', () => {
  const files = listJson(path.join(FIXTURES_DIR, 'system-event-classification'));
  assert.ok(files.length > 0, 'no system-event-classification fixtures found');
  for (const f of files) {
    const fx = readJson(f);
    assert.equal(classifySystemEvent(fx.input), fx.expected,
      `classifySystemEvent mismatch: ${path.basename(f)}`);
  }
});

// ── (b/c) inbound-message fixtures: driven through the REAL bridge pipeline ───
// A fixture supplies an org config, a raw WS frame, and the message-detail +
// conversation the http client would fetch. We run the frame through the full
// dedupe -> detail-fetch -> hoist -> conversation-fetch -> access-policy ->
// #buildInbound -> deliver() path and assert on the InboundMessage deliver() got.

class FakeWebSocket extends EventEmitter {
  constructor() { super(); this.readyState = WebSocket.OPEN; }
  ping() {} terminate() {} send() {} close() {}
}
const quietLogger = { info() {}, warn() {}, error() {}, debug() {} };
function flush(n = 4) {
  return new Promise((resolve) => {
    let i = 0;
    const tick = () => (++i >= n ? resolve() : setImmediate(tick));
    setImmediate(tick);
  });
}
function mkRes(status, body) {
  return { ok: status >= 200 && status < 300, status, statusText: `HTTP ${status}`,
    async text() { return body; }, async arrayBuffer() { return Buffer.from(body); } };
}
function routingFetch(routes) {
  return async (url, opts = {}) => {
    const method = opts.method || 'GET';
    for (const r of routes) {
      if (r.match(url, method)) return mkRes(200, JSON.stringify({ data: r.data ?? {}, request_id: 'r' }));
    }
    return mkRes(200, JSON.stringify({ data: {}, request_id: 'r' }));
  };
}

async function runInboundFixture(fx) {
  const conv = fx.frame.payload.conversation_id;
  const msgId = fx.frame.payload.id;
  const http = new CwsHttpClient({
    baseUrl: 'http://api.test',
    fetch: routingFetch([
      { match: (u, m) => m === 'GET' && new RegExp(`/conversations/${reEsc(conv)}/messages/${reEsc(msgId)}$`).test(u), data: fx.detail },
      { match: (u, m) => m === 'GET' && new RegExp(`/conversations/${reEsc(conv)}$`).test(u), data: fx.conversation },
    ]),
    logger: quietLogger,
  });
  http.setApiKey('test-key');

  const delivered = [];
  const bridge = new CwsAgentBridge({
    http,
    ws: {
      baseUrl: 'wss://test/ws',
      urlProvider: async () => 'wss://test/ws?ticket=t',
      wsFactory: () => new FakeWebSocket(),
    },
    orgConfigs: [fx.org],
    providers: {
      logger: quietLogger,
      inbound: { deliver: async (msg) => { delivered.push(msg); return { ok: true }; } },
    },
    callbacks: { syncSelf: async () => ({ nameReady: true }) },
    reporters: { metrics: false, frameMetrics: false, markReadOnDeliver: false },
  });
  await bridge.start();
  bridge.injectFrame(fx.org.slug, fx.frame);
  await flush();
  await bridge.stop();
  return delivered;
}

test('contract: inbound-message fixtures normalize through the SDK and validate against inbound-message.schema', async () => {
  const { ajv } = buildAjv();
  const validateInbound = ajv.getSchema(SCHEMA_ID.inbound);
  const files = listJson(path.join(FIXTURES_DIR, 'inbound-message'));
  assert.ok(files.length > 0, 'no inbound-message fixtures found');

  for (const f of files) {
    const fx = readJson(f);
    const name = path.basename(f);
    const delivered = await runInboundFixture(fx);
    assert.equal(delivered.length, 1, `${name}: expected exactly one delivery`);
    const msg = delivered[0];

    // (c) the SDK-produced InboundMessage validates against the schema. JSON
    // round-trip drops undefined-valued keys (e.g. omitted priority/orgName),
    // matching what a wire/serialized message would carry.
    const wire = JSON.parse(JSON.stringify(msg));
    assert.equal(validateInbound(wire), true,
      `${name}: delivered InboundMessage failed schema — ${ajv.errorsText(validateInbound.errors)}`);

    // (b) the SDK output equals the fixture's expected fields.
    for (const [k, v] of Object.entries(fx.expected)) {
      if (k === 'decisionReasonIncludes') {
        assert.ok(String(msg.decision?.reason || '').includes(v),
          `${name}: decision.reason "${msg.decision?.reason}" does not include "${v}"`);
      } else if (k === 'senderIdAbsent') {
        // P2: the SDK delivered a message with an UNRESOLVED sender — senderId
        // must be absent (undefined → dropped on the JSON round-trip) yet the
        // message still validates (senderId is not required).
        assert.equal(msg.senderId, undefined, `${name}: expected senderId absent`);
        assert.equal('senderId' in wire, false, `${name}: senderId must not appear on the wire`);
      } else if (k === 'decisionOwnerNameHint') {
        assert.equal(msg.decision?.ownerNameHint, v, `${name}: decision.ownerNameHint mismatch`);
      } else {
        assert.deepEqual(msg[k], v, `${name}: field "${k}" mismatch`);
      }
    }
  }
});

// ── (c) wake-request corpus validates against wake-request.schema ────────────
test('contract: wake-request fixtures validate as expected', () => {
  const { ajv } = buildAjv();
  const validate = ajv.getSchema(SCHEMA_ID.wakeRequest);
  const files = listJson(path.join(FIXTURES_DIR, 'wake-request'));
  assert.ok(files.length > 0, 'no wake-request fixtures found');
  for (const f of files) {
    const fx = readJson(f);
    assert.equal(validate(fx.input), fx.expectValid,
      `${path.basename(f)}: expectValid=${fx.expectValid}, got ${!fx.expectValid} — ${ajv.errorsText(validate.errors)}`);
  }
});

// ── (c) wake-result corpus validates (refs failure-class.schema) ─────────────
test('contract: wake-result fixtures validate as expected (incl. failure-class enum)', () => {
  const { ajv } = buildAjv();
  const validate = ajv.getSchema(SCHEMA_ID.wakeResult);
  const files = listJson(path.join(FIXTURES_DIR, 'wake-result'));
  assert.ok(files.length > 0, 'no wake-result fixtures found');
  for (const f of files) {
    const fx = readJson(f);
    assert.equal(validate(fx.input), fx.expectValid,
      `${path.basename(f)}: expectValid=${fx.expectValid}, got ${!fx.expectValid} — ${ajv.errorsText(validate.errors)}`);
  }
});
