'use strict';
// Provider-agnostic model client with a concurrency cap, per-call timeout and bounded retries.
//   LLM_PROVIDER = openai (default; any OpenAI-compatible /chat/completions) | anthropic | stub
//   LLM_BASE_URL, LLM_API_KEY, LLM_MODEL
// Examples:
//   OpenAI:      LLM_BASE_URL=https://api.openai.com/v1                              LLM_MODEL=gpt-4o-mini
//   Gemini:      LLM_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai LLM_MODEL=gemini-2.0-flash
//   Groq:        LLM_BASE_URL=https://api.groq.com/openai/v1                          LLM_MODEL=llama-3.3-70b-versatile
//   OpenRouter:  LLM_BASE_URL=https://openrouter.ai/api/v1                            LLM_MODEL=<any>
//   Ollama:      LLM_BASE_URL=http://localhost:11434/v1  LLM_API_KEY=ollama           LLM_MODEL=llama3.1
//   Anthropic:   LLM_PROVIDER=anthropic                                               LLM_MODEL=claude-haiku-5-5
const PROVIDER = (process.env.LLM_PROVIDER || 'openai').toLowerCase();
const API_KEY = process.env.LLM_API_KEY || '';
const MODEL = process.env.LLM_MODEL || (PROVIDER === 'anthropic' ? 'claude-haiku-5-5' : 'gpt-4o-mini');
const BASE_URL = (process.env.LLM_BASE_URL ||
  (PROVIDER === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1')).replace(/\/+$/, '');
const CONCURRENCY = Math.max(1, +process.env.LLM_CONCURRENCY || 6);
const CALL_TIMEOUT_MS = +process.env.LLM_TIMEOUT_MS || 40000;
const MAX_RETRIES = Math.min(3, Math.max(0, process.env.LLM_RETRIES === undefined ? 2 : +process.env.LLM_RETRIES));
const JSON_MODE = process.env.LLM_JSON_MODE !== '0';
const MAX_TOKENS_PARAM = process.env.LLM_MAX_TOKENS_PARAM || 'max_tokens';

let active = 0;
const waiters = [];
async function acquire() {
  if (active < CONCURRENCY) { active++; return; }
  await new Promise((r) => waiters.push(r));
  active++;
}
function release() {
  active--;
  const n = waiters.shift();
  if (n) n();
}

const stats = { calls: 0, retries: 0, failures: 0 };

async function once({ system, user, maxTokens }) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), CALL_TIMEOUT_MS);
  try {
    let url; let headers; let body;
    if (PROVIDER === 'anthropic') {
      url = `${BASE_URL}/v1/messages`;
      headers = { 'content-type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' };
      body = { model: MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] };
    } else {
      url = `${BASE_URL}/chat/completions`;
      headers = { 'content-type': 'application/json' };
      if (API_KEY) headers.authorization = `Bearer ${API_KEY}`;
      body = {
        model: MODEL,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        [MAX_TOKENS_PARAM]: maxTokens,
      };
      if (process.env.LLM_TEMPERATURE !== 'omit') body.temperature = +(process.env.LLM_TEMPERATURE || 0);
      if (JSON_MODE) body.response_format = { type: 'json_object' };
    }
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctl.signal, redirect: 'error' });
    const raw = await res.text();
    if (!res.ok) {
      const err = new Error(`model http ${res.status}: ${raw.slice(0, 200)}`);
      err.retriable = res.status === 429 || res.status >= 500 || res.status === 408;
      throw err;
    }
    const j = JSON.parse(raw);
    const text = PROVIDER === 'anthropic'
      ? (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('')
      : j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    if (typeof text !== 'string' || !text.trim()) {
      const err = new Error('model returned no text');
      err.retriable = true;
      throw err;
    }
    return text;
  } catch (e) {
    if (e.name === 'AbortError') { e.message = 'model call timed out'; e.retriable = true; }
    else if (e.retriable === undefined) e.retriable = e instanceof TypeError; // network errors
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function complete(args) {
  await acquire();
  try {
    let lastErr;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        stats.calls++;
        return await once(args);
      } catch (e) {
        lastErr = e;
        if (!e.retriable || attempt === MAX_RETRIES) break;
        stats.retries++;
        await new Promise((r) => setTimeout(r, 800 * 2 ** attempt + Math.random() * 400));
      }
    }
    stats.failures++;
    throw lastErr;
  } finally {
    release();
  }
}

module.exports = { complete, PROVIDER, MODEL, stats };
