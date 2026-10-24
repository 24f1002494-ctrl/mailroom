'use strict';
// Smoke test of the Vercel entry point (api/index.js): Vercel pre-parses req.body, rewrites every
// path to the function, and may have no readable stream. Uses the file store + stub model.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mailroom-vercel-'));
process.env.LLM_PROVIDER = 'stub';
for (const k of ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'KV_REST_API_URL', 'KV_REST_API_TOKEN']) delete process.env[k];
delete process.env.VERCEL;
const handler = require('../api/index.js');

// emulate Vercel: collect the body, expose it as req.body (parsed JSON when content-type is JSON), then call the handler
const srv = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks);
    if (raw.length) {
      Object.defineProperty(req, 'body', {
        get() { return JSON.parse(raw.toString('utf8')); }, // throws on invalid JSON like Vercel's lazy parser
      });
    }
    req.removeAllListeners('data');
    handler(req, res);
  });
});

(async () => {
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/some/path`;
  const call = async (body, raw) => {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw !== undefined ? raw : JSON.stringify(body) });
    return { status: res.status, type: res.headers.get('content-type'), json: await res.json() };
  };
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  const dossiers = [{ dossierId: 'v1', receivedAt: 'x', mailbox: 'a@b.test', objective: 'o', sources: [{ sourceId: 's', kind: 'k', provenance: 'p', title: 't', lines: [{ lineId: 's.1', text: 'hello ORD-123' }] }] }];
  const body = { profile: 'ga5-mailroom-action-gate/v2', operation: 'propose', evaluationId: 'v-eval', receiptVerifier: { algorithm: 'Ed25519', publicKeyJwk: publicKey.export({ format: 'jwk' }) }, dossiers };

  let r = await call(body);
  assert.strictEqual(r.status, 200); assert.strictEqual(r.type, 'application/json');
  assert.strictEqual(r.json.status, 'awaiting_receipts'); assert.strictEqual(r.json.proposals.length, 1);
  console.log('  ok  propose through Vercel-style handler (pre-parsed body)');
  const again = await call(body);
  assert.deepStrictEqual(again.json, r.json);
  console.log('  ok  replay identical');
  r = await call(null, '{bad json');
  assert.strictEqual(r.status, 400);
  console.log('  ok  invalid JSON => 400 JSON error');
  const g = await fetch(url); const gj = await g.json();
  assert.strictEqual(g.status, 200); assert.strictEqual(gj.ok, true);
  console.log('  ok  GET health');
  srv.close();
  console.log('\nVERCEL HANDLER OK');
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
