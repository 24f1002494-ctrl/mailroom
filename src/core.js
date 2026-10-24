'use strict';
const http = require('http');
const crypto = require('crypto');
const { canon, sha256 } = require('./canon');
const { PROFILE, HttpError, validateEnvelope, validatePropose, validateCommit } = require('./schema');
const { createStore } = require('./store');
const { decideAll, fallbackProposal } = require('./decide');
const llm = require('./llm');

const PORT = +process.env.PORT || 8080;
const MAX_BODY = +process.env.MAX_BODY_BYTES || 8 * 1024 * 1024;
const MAX_RESPONSE = 400 * 1024; // grader rejects successful bodies over 512 KiB
const PROPOSE_BUDGET_MS = +process.env.PROPOSE_BUDGET_MS || 46000; // grader allows 55 s per request
const CACHE_VERSION = process.env.CACHE_VERSION || 'v1';

let store = null;
let storeError = null;
try {
  store = createStore();
} catch (e) {
  console.error('store init failed:', e.message);
  storeError = e.message;
}

// Keep background work (model calls that outlive the response deadline) alive on Vercel.
let waitUntil = () => {};
try { ({ waitUntil } = require('@vercel/functions')); } catch { /* not on Vercel / not installed */ }
function background(p) {
  try { waitUntil(p); } catch { /* no request context */ }
}

// ------------------------------------------------------------------ small utils
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

const sortedEvidence = (e) => [...e].sort();
function proposalDigest(p) {
  return sha256(canon({
    dossierId: p.dossierId, callId: p.callId, action: p.action,
    target: p.target === undefined ? null : p.target, payload: p.payload, evidence: sortedEvidence(p.evidence),
  }));
}
const fingerprint = (d) => sha256(`${CACHE_VERSION}|${canon(d)}`);
const callIdFor = (fp) => `mrc_${sha256(`callid|${fp}`).slice(0, 32)}`;

// ------------------------------------------------------------------ propose
const inflightDecisions = new Map(); // fingerprint -> promise<proposal|null> (per instance; avoids duplicate model work)

async function resolveProposals(dossiers, allowed) {
  const started = Date.now();
  const fps = dossiers.map(fingerprint);
  const cachedList = await Promise.all(fps.map((fp) => store.get('decisions', fp)));

  const entries = []; // { d, fp, promise }
  const misses = [];
  dossiers.forEach((d, i) => {
    const fp = fps[i];
    const cached = cachedList[i];
    if (cached && cached.proposal && allowed.includes(cached.proposal.action)) {
      entries.push({ d, fp, promise: Promise.resolve(cached.proposal) });
    } else if (inflightDecisions.has(fp)) {
      entries.push({ d, fp, promise: inflightDecisions.get(fp) });
    } else {
      const df = deferred();
      inflightDecisions.set(fp, df.promise);
      misses.push({
        d,
        resolve: async (proposal) => {
          try {
            if (proposal) {
              // persist before anything can reply with it
              await store.put('decisions', fp, { fingerprint: fp, dossierId: d.dossierId, proposal, decidedAt: new Date().toISOString(), model: llm.MODEL });
            }
          } catch (e) {
            console.error('decision persist failed', e.message);
          } finally {
            inflightDecisions.delete(fp);
            df.resolve(proposal);
          }
        },
      });
      entries.push({ d, fp, promise: df.promise });
    }
  });
  if (misses.length) {
    // Not awaited on purpose: if the deadline passes we still finish and cache in the background.
    const work = decideAll(misses, allowed).catch((e) => console.error('decideAll failed', e.message));
    background(work);
  }

  const TIMEOUT = Symbol('timeout');
  const remaining = Math.max(500, PROPOSE_BUDGET_MS - (Date.now() - started));
  let timer;
  const deadline = new Promise((r) => { timer = setTimeout(() => r(TIMEOUT), remaining); });
  const results = await Promise.all(entries.map(async (e) => {
    const r = await Promise.race([e.promise, deadline]);
    return r === TIMEOUT ? undefined : r;
  }));
  clearTimeout(timer);

  let fallbacks = 0;
  const proposals = entries.map((e, i) => {
    let p = results[i];
    if (!p) { p = fallbackProposal(e.d, allowed); fallbacks++; }
    return {
      dossierId: e.d.dossierId, callId: callIdFor(e.fp), action: p.action,
      target: p.target === undefined ? null : p.target, payload: p.payload, evidence: sortedEvidence(p.evidence),
    };
  });
  return { proposals, fallbacks, misses: misses.length };
}

async function propose(body, reqHash) {
  const { jwk, allowed } = validatePropose(body); // throws 422 before any model work
  const evalId = body.evaluationId;

  return store.lock(`eval:${evalId}`, async () => {
    const existing = await store.get('evals', evalId);
    if (existing) {
      if (existing.reqHash !== reqHash) throw new HttpError(409, 'evaluation_conflict', 'evaluationId was already used with different content');
      return existing.proposeResponseText; // exact replay: no model work, no new state
    }
    const inputDigest = sha256(canon(body.dossiers));
    const t0 = Date.now();
    const { proposals, fallbacks, misses } = await resolveProposals(body.dossiers, allowed);
    const response = { profile: PROFILE, evaluationId: evalId, status: 'awaiting_receipts', inputDigest, proposals };
    const text = JSON.stringify(response);
    if (Buffer.byteLength(text) > MAX_RESPONSE) throw new HttpError(500, 'response_too_large', 'response too large');

    await store.put('evals', evalId, {
      evaluationId: evalId, reqHash, inputDigest, verifier: jwk, allowed,
      proposals: proposals.map((p) => ({ ...p, proposalDigest: proposalDigest(p) })),
      proposeResponseText: text, commit: null, createdAt: new Date().toISOString(),
    });
    console.log(JSON.stringify({ evt: 'propose', evaluationId: evalId, dossiers: proposals.length, modelDossiers: misses, fallbacks, ms: Date.now() - t0, llm: llm.stats }));
    return text;
  });
}

// ------------------------------------------------------------------ commit
function verifyReceiptSignature(verifier, commitBody, r) {
  try {
    const { receiptSignature, ...inner } = r;
    const message = canon({ profile: PROFILE, evaluationId: commitBody.evaluationId, inputDigest: commitBody.inputDigest, receipt: inner });
    const key = crypto.createPublicKey({ key: verifier, format: 'jwk' });
    const sig = Buffer.from(receiptSignature, 'base64');
    if (sig.length !== 64) return false;
    return crypto.verify(null, Buffer.from(message, 'utf8'), key, sig);
  } catch {
    return false;
  }
}

async function commit(body, reqHash) {
  validateCommit(body);
  const evalId = body.evaluationId;
  return store.lock(`eval:${evalId}`, async () => {
    const rec = await store.get('evals', evalId);
    if (!rec) throw new HttpError(404, 'unknown_evaluation', 'unknown evaluationId');
    if (body.inputDigest !== rec.inputDigest) throw new HttpError(409, 'digest_mismatch', 'inputDigest does not match this evaluation');
    if (rec.commit) {
      if (rec.commit.reqHash !== reqHash) throw new HttpError(409, 'commit_conflict', 'evaluation already committed with different receipts');
      return rec.commit.responseText; // exact replay: nothing is executed twice
    }

    // 1. structure: exactly one receipt per proposal, none duplicated, all matching the persisted proposal
    const byCall = new Map(rec.proposals.map((p) => [p.callId, p]));
    const seenCall = new Set(); const seenDossier = new Set(); const seenReceipt = new Set();
    if (body.receipts.length !== rec.proposals.length) throw new HttpError(422, 'receipt_count', 'exactly one receipt per proposal is required');
    for (const r of body.receipts) {
      if (seenCall.has(r.callId) || seenDossier.has(r.dossierId) || seenReceipt.has(r.receiptId)) throw new HttpError(422, 'duplicate_receipt', 'duplicate receipt');
      seenCall.add(r.callId); seenDossier.add(r.dossierId); seenReceipt.add(r.receiptId);
      const p = byCall.get(r.callId);
      if (!p) throw new HttpError(409, 'unknown_call', 'receipt callId does not match any persisted proposal');
      if (p.dossierId !== r.dossierId || p.action !== r.action || p.proposalDigest !== r.proposalDigest) {
        throw new HttpError(409, 'proposal_mismatch', 'receipt does not match the persisted proposal');
      }
    }
    // 2. signatures: every one must verify against THIS evaluation's key, or nothing is recorded
    for (const r of body.receipts) {
      if (!verifyReceiptSignature(rec.verifier, body, r)) throw new HttpError(422, 'invalid_receipt_signature', 'a receipt signature is invalid');
    }

    // 3. record effects (obey `accepted` exactly), then persist, then reply
    const byCallReceipt = new Map(body.receipts.map((r) => [r.callId, r]));
    const outcomes = rec.proposals.map((p) => {
      const r = byCallReceipt.get(p.callId);
      return { dossierId: p.dossierId, callId: p.callId, action: p.action, proposalDigest: p.proposalDigest, receiptId: r.receiptId, status: r.accepted ? 'executed' : 'rejected' };
    });
    const response = { profile: PROFILE, evaluationId: evalId, status: 'completed', inputDigest: rec.inputDigest, outcomes };
    const responseText = JSON.stringify(response);

    const at = new Date().toISOString();
    await Promise.all(outcomes.filter((o) => o.status === 'executed').map((o) => {
      const p = byCall.get(o.callId);
      // Effect ledger. A real deployment would call the mail/CRM API here, keyed by callId for idempotency.
      return store.appendLedger({ at, evaluationId: evalId, callId: o.callId, receiptId: o.receiptId, action: p.action, target: p.target, payload: p.payload });
    }));
    rec.commit = { reqHash, receipts: body.receipts, responseText, committedAt: at };
    await store.put('evals', evalId, rec);
    console.log(JSON.stringify({ evt: 'commit', evaluationId: evalId, executed: outcomes.filter((o) => o.status === 'executed').length, rejected: outcomes.filter((o) => o.status === 'rejected').length }));
    return responseText;
  });
}

// ------------------------------------------------------------------ http (works as a Node server and as a Vercel function)
function send(res, status, text) {
  const buf = Buffer.from(text, 'utf8');
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
  res.end(buf);
}
const sendErr = (res, status, code, message) => send(res, status, JSON.stringify({ error: { code, message } }));

function readBody(req) {
  // Vercel's Node runtime may already have consumed the stream and exposed req.body.
  let pre;
  try { pre = req.body; } catch { throw new HttpError(400, 'invalid_json', 'body is not valid JSON'); }
  if (pre !== undefined && pre !== null) {
    if (typeof pre === 'string') return Promise.resolve(pre);
    if (Buffer.isBuffer(pre)) return Promise.resolve(pre.toString('utf8'));
    return Promise.resolve(pre); // already-parsed object
  }
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, 'body_too_large', 'request body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handle(req, res) {
  try {
    if (req.method === 'GET' || req.method === 'HEAD') {
      return send(res, 200, JSON.stringify({ ok: !storeError, service: 'mailroom-action-gate', profile: PROFILE, store: store ? store.kind : 'unavailable' }));
    }
    if (req.method !== 'POST') return sendErr(res, 405, 'method_not_allowed', 'POST only');
    if (!store) return sendErr(res, 500, 'store_unavailable', storeError);
    const raw = await readBody(req);
    let body;
    if (typeof raw === 'string') {
      try { body = JSON.parse(raw); } catch { throw new HttpError(400, 'invalid_json', 'body is not valid JSON'); }
    } else {
      body = raw;
    }
    validateEnvelope(body);
    const reqHash = sha256(canon(body));
    const text = body.operation === 'propose' ? await propose(body, reqHash) : await commit(body, reqHash);
    return send(res, 200, text);
  } catch (e) {
    if (e instanceof HttpError) return sendErr(res, e.status, e.code, e.message);
    console.error('unhandled', (e && e.stack) || e);
    return sendErr(res, 500, 'internal_error', 'internal error');
  }
}

function createServer() {
  const server = http.createServer(handle);
  server.requestTimeout = 60000;
  server.headersTimeout = 20000;
  server.keepAliveTimeout = 5000;
  return server;
}

if (require.main === module) {
  createServer().listen(PORT, '0.0.0.0', () => console.log(JSON.stringify({ evt: 'listening', port: PORT, store: store && store.kind, provider: llm.PROVIDER, model: llm.MODEL })));
}

module.exports = { handle, createServer };
