'use strict';
// Strict, atomic request validation. Everything here runs BEFORE any model/tool work.
const crypto = require('crypto');

const PROFILE = 'ga5-mailroom-action-gate/v2';
const ACTIONS = [
  'create_draft', 'update_internal_record', 'send_approved_notice',
  'request_confirmation', 'quarantine_item', 'no_action',
];

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v, min = 0, max = 200000) => typeof v === 'string' && v.length >= min && v.length <= max;
function bad(msg, status = 422) { throw new HttpError(status, 'invalid_request', msg); }

function validateEnvelope(body) {
  if (!isObj(body)) bad('body must be a JSON object', 400);
  if (body.profile !== PROFILE) bad('unsupported profile', 400);
  if (body.operation !== 'propose' && body.operation !== 'commit') bad('invalid operation', 400);
  if (!isStr(body.evaluationId, 1, 256)) bad('evaluationId must be a non-empty string');
}

function validatePropose(body) {
  const v = body.receiptVerifier;
  if (!isObj(v) || v.algorithm !== 'Ed25519' || !isObj(v.publicKeyJwk)) bad('receiptVerifier must be an Ed25519 JWK verifier');
  const jwk = v.publicKeyJwk;
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || !isStr(jwk.x, 1, 200)) bad('publicKeyJwk must be an OKP/Ed25519 key');
  try {
    const k = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: jwk.x }, format: 'jwk' });
    if (k.asymmetricKeyType !== 'ed25519') bad('publicKeyJwk is not Ed25519');
  } catch (e) {
    if (e instanceof HttpError) throw e;
    bad('publicKeyJwk cannot be imported');
  }

  let allowed = ACTIONS.slice();
  if (body.allowedActions !== undefined) {
    if (!Array.isArray(body.allowedActions) || body.allowedActions.length === 0) bad('allowedActions must be a non-empty array');
    for (const a of body.allowedActions) if (!ACTIONS.includes(a)) bad(`unknown allowed action: ${String(a).slice(0, 40)}`);
    allowed = [...new Set(body.allowedActions)];
  }
  if (body.corpus !== undefined && !isObj(body.corpus)) bad('corpus must be an object');

  const ds = body.dossiers;
  if (!Array.isArray(ds) || ds.length === 0 || ds.length > 400) bad('dossiers must be a non-empty array (max 400)');
  const seen = new Set();
  for (const d of ds) {
    if (!isObj(d)) bad('each dossier must be an object');
    if (!isStr(d.dossierId, 1, 256)) bad('dossierId must be a non-empty string');
    if (seen.has(d.dossierId)) bad('duplicate dossierId');
    seen.add(d.dossierId);
    if (!isStr(d.mailbox, 1, 512)) bad(`dossier ${d.dossierId}: mailbox must be a non-empty string`);
    for (const f of ['objective', 'receivedAt', 'partition']) {
      if (d[f] !== undefined && !isStr(d[f])) bad(`dossier ${d.dossierId}: ${f} must be a string`);
    }
    if (!Array.isArray(d.sources) || d.sources.length > 300) bad(`dossier ${d.dossierId}: sources must be an array`);
    for (const s of d.sources) {
      if (!isObj(s) || !isStr(s.sourceId, 1, 256)) bad(`dossier ${d.dossierId}: bad source`);
      for (const f of ['kind', 'provenance', 'title']) {
        if (s[f] !== undefined && !isStr(s[f])) bad(`dossier ${d.dossierId}: source ${f} must be a string`);
      }
      if (!Array.isArray(s.lines) || s.lines.length > 3000) bad(`dossier ${d.dossierId}: source lines must be an array`);
      for (const l of s.lines) {
        if (!isObj(l) || !isStr(l.lineId, 1, 256) || typeof l.text !== 'string') bad(`dossier ${d.dossierId}: bad line`);
      }
    }
  }
  return { jwk: { kty: 'OKP', crv: 'Ed25519', x: jwk.x }, allowed };
}

function validateCommit(body) {
  if (!isStr(body.inputDigest, 64, 64) || !/^[0-9a-f]{64}$/.test(body.inputDigest)) bad('inputDigest must be 64 lowercase hex chars');
  const rs = body.receipts;
  if (!Array.isArray(rs) || rs.length === 0 || rs.length > 1000) bad('receipts must be a non-empty array');
  for (const r of rs) {
    if (!isObj(r)) bad('each receipt must be an object');
    for (const f of ['dossierId', 'callId', 'action', 'proposalDigest', 'receiptId', 'receiptSignature']) {
      if (!isStr(r[f], 1, 4096)) bad(`receipt.${f} must be a non-empty string`);
    }
    if (typeof r.accepted !== 'boolean') bad('receipt.accepted must be a boolean');
  }
}

module.exports = { PROFILE, ACTIONS, HttpError, validateEnvelope, validatePropose, validateCommit };
