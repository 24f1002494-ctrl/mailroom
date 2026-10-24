'use strict';
// Canonical JSON (recursively key-sorted, compact) + SHA-256 helpers.
// Set DIGEST_ASCII=1 to escape non-ASCII like Python's json.dumps(ensure_ascii=True)
// in case the grader's digest disagrees on dossiers containing non-ASCII text.
const crypto = require('crypto');

const ASCII = process.env.DIGEST_ASCII === '1';

function str(s) {
  let j = JSON.stringify(s);
  if (ASCII) {
    j = j.replace(/[\u007f-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  }
  return j;
}

function canon(v) {
  if (v === null || v === undefined) return 'null';
  switch (typeof v) {
    case 'string': return str(v);
    case 'number': return Number.isFinite(v) ? JSON.stringify(v) : 'null';
    case 'boolean': return v ? 'true' : 'false';
    case 'object': {
      if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
      const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
      return '{' + keys.map((k) => str(k) + ':' + canon(v[k])).join(',') + '}';
    }
    default: return 'null';
  }
}

const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

module.exports = { canon, sha256 };
