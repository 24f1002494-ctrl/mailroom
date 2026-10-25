'use strict';
// Durable store with two interchangeable backends (all methods async):
//   * Redis over REST (Upstash / Vercel Marketplace "Upstash Redis"): used when
//       UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN   (or KV_REST_API_URL + KV_REST_API_TOKEN) are set.
//       Required on Vercel, whose filesystem is ephemeral and per-instance.
//   * Atomic JSON files under DATA_DIR: for a VM/container with a persistent volume.
// Interface: get(kind,key) / put(kind,key,obj) / appendLedger(line) / lock(key, fn)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { sha256 } = require('./canon');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// in-process FIFO mutex per key (the Redis lock below additionally covers other instances)
class LocalLock {
  constructor() { this.tails = new Map(); }
  async run(key, fn) {
    const prev = this.tails.get(key) || Promise.resolve();
    let release;
    const mine = new Promise((r) => { release = r; });
    const tail = prev.then(() => mine);
    this.tails.set(key, tail);
    await prev;
    try { return await fn(); } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

class FileStore {
  constructor(dir) {
    this.dir = dir;
    this.local = new LocalLock();
    for (const sub of ['decisions', 'evals']) fs.mkdirSync(path.join(dir, sub), { recursive: true });
    this.ledger = path.join(dir, 'effects.jsonl');
    this.kind = 'file';
  }

  _file(kind, key) { return path.join(this.dir, kind, sha256(key) + '.json'); }

  async get(kind, key) {
    try {
      return JSON.parse(fs.readFileSync(this._file(kind, key), 'utf8'));
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
  }

  async put(kind, key, obj) {
    fs.mkdirSync(path.join(this.dir, kind), { recursive: true });
    const file = this._file(kind, key);
    const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, JSON.stringify(obj));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  }

  async appendLedger(line) {
    const fd = fs.openSync(this.ledger, 'a');
    try {
      fs.writeSync(fd, JSON.stringify(line) + '\n');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  lock(key, fn) { return this.local.run(key, fn); }

  async listPush(name, val, cap = 400) {
    const f = path.join(this.dir, `list-${name}.jsonl`);
    fs.appendFileSync(f, JSON.stringify(val) + '\n');
  }

  async listRange(name, n = 400) {
    try {
      return fs.readFileSync(path.join(this.dir, `list-${name}.jsonl`), 'utf8').split('\n').filter(Boolean).slice(-n).map((l) => JSON.parse(l));
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
  }
}

class RedisStore {
  constructor(url, token, prefix) {
    this.url = url.replace(/\/+$/, '');
    this.token = token;
    this.prefix = prefix || 'mr';
    this.local = new LocalLock();
    this.kind = 'redis';
  }

  async cmd(args) {
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 10000);
      try {
        const res = await fetch(this.url, {
          method: 'POST',
          headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
          body: JSON.stringify(args), signal: ctl.signal, redirect: 'error',
        });
        const j = await res.json().catch(() => ({}));
        if (res.ok && !j.error) return j.result;
        lastErr = new Error(`redis http ${res.status}: ${String(j.error || '').slice(0, 160)}`);
        if (res.status < 500 && res.status !== 429) throw lastErr;
      } catch (e) {
        lastErr = e;
        if (e.message && e.message.startsWith('redis http 4') ) throw e;
      } finally {
        clearTimeout(timer);
      }
      await sleep(150 * 2 ** attempt);
    }
    throw lastErr;
  }

  _key(kind, key) { return `${this.prefix}:${kind}:${sha256(key)}`; }

  async get(kind, key) {
    const v = await this.cmd(['GET', this._key(kind, key)]);
    return v === null || v === undefined ? null : JSON.parse(v);
  }

  async put(kind, key, obj) {
    const r = await this.cmd(['SET', this._key(kind, key), JSON.stringify(obj)]);
    if (r !== 'OK') throw new Error('redis SET failed');
  }

  async appendLedger(line) {
    await this.cmd(['RPUSH', `${this.prefix}:ledger`, JSON.stringify(line)]);
  }

  async listPush(name, val, cap = 400) {
    const k = `${this.prefix}:list:${name}`;
    await this.cmd(['RPUSH', k, JSON.stringify(val)]);
    await this.cmd(['LTRIM', k, String(-cap), '-1']);
  }

  async listRange(name, n = 400) {
    const r = await this.cmd(['LRANGE', `${this.prefix}:list:${name}`, String(-n), '-1']);
    return (r || []).map((x) => JSON.parse(x));
  }

  // distributed lock (SET NX PX + compare-and-delete) so concurrent serverless instances serialise per evaluation
  lock(key, fn) {
    return this.local.run(key, async () => {
      const k = `${this.prefix}:lock:${sha256(key)}`;
      const token = crypto.randomBytes(12).toString('hex');
      const deadline = Date.now() + 58000;
      for (;;) {
        const r = await this.cmd(['SET', k, token, 'NX', 'PX', '70000']);
        if (r === 'OK') break;
        if (Date.now() > deadline) throw new Error('lock timeout');
        await sleep(120 + Math.random() * 80);
      }
      try {
        return await fn();
      } finally {
        try {
          await this.cmd(['EVAL', "if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end", '1', k, token]);
        } catch { /* lock expires on its own */ }
      }
    });
  }
}

function createStore() {
  const env = process.env;
  const url = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN;
  if (url && token) return new RedisStore(url, token, env.REDIS_PREFIX);
  if (env.VERCEL) {
    throw new Error('Vercel has no durable disk: add an Upstash Redis store (sets KV_REST_API_URL/KV_REST_API_TOKEN) to this project');
  }
  return new FileStore(env.DATA_DIR || path.join(process.cwd(), 'data'));
}

module.exports = { createStore, FileStore, RedisStore };
