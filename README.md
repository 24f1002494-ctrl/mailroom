# Mailroom action gate

AI reads the mail; plain code decides what is allowed to happen.

```
POST /  {operation:"propose"}  -> validate -> cache lookup by dossier fingerprint
                                  -> model picks action + evidence + short args (batched, 5/call)
                                  -> code builds the frozen target/payload, grounds every value in
                                     cited lines, reviews effectful actions with a 2nd model call
                                  -> persist -> {status:"awaiting_receipts", proposals}
POST /  {operation:"commit"}   -> validate -> match each receipt to the persisted proposal
                                  -> verify EVERY Ed25519 signature (key stored from that propose)
                                  -> only then record effects (accepted:true => executed)
```

Zero dependencies (Node >= 20). State is plain files under `DATA_DIR`.

## Run

```bash
export LLM_API_KEY=...            # your model key
export LLM_PROVIDER=openai        # openai (any OpenAI-compatible API) | anthropic | stub
export LLM_BASE_URL=https://api.openai.com/v1
export LLM_MODEL=gpt-4o-mini
export DATA_DIR=./data
node src/server.js                # listens on $PORT (default 8080)
```

Other providers: Gemini `LLM_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai`,
Groq `https://api.groq.com/openai/v1`, OpenRouter `https://openrouter.ai/api/v1`,
Ollama `http://localhost:11434/v1`; Anthropic: `LLM_PROVIDER=anthropic LLM_MODEL=claude-haiku-5-5`.
If a provider rejects `response_format`, set `LLM_JSON_MODE=0`; if it wants `max_completion_tokens`,
set `LLM_MAX_TOKENS_PARAM=max_completion_tokens`; for models that reject `temperature`, `LLM_TEMPERATURE=omit`.

## Public HTTPS URL

The submitted URL must be HTTPS with no credentials/query/fragment, e.g. `https://mailroom.example.com/`.

- **Vercel (recommended, no server to manage):**
  1. `npm i -g vercel && cd mailroom && vercel` (accept defaults; no build step).
  2. In the Vercel dashboard: Storage / Marketplace, add **Upstash Redis** and connect it to the project. This injects
     `KV_REST_API_URL` and `KV_REST_API_TOKEN` (or `UPSTASH_REDIS_REST_URL`/`_TOKEN`), which the app uses automatically.
     Without it the function refuses to start, because Vercel's disk is not durable.
  3. Project Settings, Environment Variables: `LLM_API_KEY`, `LLM_MODEL`, `LLM_BASE_URL` (and `LLM_PROVIDER` if not OpenAI-compatible).
  4. `vercel --prod`, then submit `https://<project>.vercel.app/`.
  `vercel.json` rewrites every path to `api/index.js` and sets `maxDuration` to 60 s (each grader request allows 55 s).
  The state store is Redis, with a distributed lock per evaluation so concurrent instances cannot double-commit.
  Model work that outlives the 46 s response budget keeps running via `waitUntil` and is cached for the next evaluation.
  Check the Vercel project's maximum function duration on your plan is at least 60 s.
- **Fastest local option (keeps your local disk, so state persists):** `cloudflared tunnel --url http://localhost:8080`
  and submit the printed `https://*.trycloudflare.com/` URL.
- **Fly.io:** `fly launch` (uses the Dockerfile), `fly volumes create data --size 1`, mount it at `/data`,
  `fly secrets set LLM_API_KEY=...`, set `LLM_MODEL`/`LLM_BASE_URL` in `fly.toml [env]`.
- **Render/Railway:** deploy the Dockerfile and attach a persistent disk at `/data`.
  Without a persistent disk a restart loses receipts/cache and replays will fail, so do not use an ephemeral disk.

Check it is up: `curl https://<your-url>/` returns `{"ok":true,...}`.

## Environment

| var | default | meaning |
|---|---|---|
| `DATA_DIR` | `./data` | persistent state (decision cache, evaluations, receipts, effect ledger) |
| `LLM_CONCURRENCY` | 6 | parallel model calls |
| `BATCH_SIZE` | 5 | dossiers per model call |
| `LLM_TIMEOUT_MS` / `LLM_RETRIES` | 40000 / 2 | per-call timeout / bounded retries |
| `PROPOSE_BUDGET_MS` | 46000 | after this, unfinished dossiers get a safe no-effect fallback (not cached) while the model keeps working and caches in the background |
| `CACHE_VERSION` | v1 | bump to invalidate the decision cache after changing the prompt |
| `DIGEST_ASCII` | 0 | set 1 only if the grader's `inputDigest` disagrees on non-ASCII dossiers (Python-style `ensure_ascii`) |

## Safety design

- The model only chooses `action`, evidence `lineId`s and a few short ids/values. Code builds every `target` and `payload`
  in the frozen shapes, forces constants (`template`, `questionCode`, `reasonCode`, `field`, queue ids).
- Every variable value must appear verbatim in a cited line (missing lines are added only if the value exists elsewhere in the
  dossier); values containing canary/secret/vault-style content, newlines or >200 chars are rejected. Raw mail never reaches an argument.
- `send_approved_notice` and `update_internal_record` need a second, adversarial model review of scope and currency;
  a rejection feeds back into a retry that must choose a safer action.
- If the model is down or keeps failing the validator, a deterministic fallback proposes only effect-free actions
  (`quarantine_item` on steering text, else `no_action`). It is never cached.
- Commit verifies all signatures against the key stored for that evaluation before recording anything; one bad,
  missing, duplicated or moved receipt rejects the whole commit. Replays return the stored bytes and never repeat an effect.

## HTTP statuses

400 bad JSON / profile / operation · 422 schema or receipt-signature/shape failure · 404 unknown evaluation on commit ·
409 same `evaluationId` with changed content, digest mismatch, or receipt that does not match the persisted proposal.

## Tests

`npm test` runs three suites: the full lifecycle against the file store, the same lifecycle against a fake Upstash Redis
(plus lock checks), and a Vercel-style handler smoke test. Each uses a fake OpenAI-compatible model and a mock grader
(shapes, cache, replay, 409s, malformed input without model calls, signature tampering/transfer, restart durability).

Effects go to `DATA_DIR/effects.jsonl` (simulated). In production, call your mail/CRM API at that point, keyed by `callId`.
