# Sift

AI inbox triage service, built as a SWE co-op resume project.

## Working agreement

- Pause after each phase so the user can review before the next one starts.
- Unit tests stay mocked. Live LLM calls are opt-in (`npm run test:live`) and use synthetic sample emails only, never real inbox content.

## Status

**Complete at Phase 4.** The project was wrapped up after Phase 4; Phases 5–10 below were not built and are listed as "Future work" in the README.

Built: schema, rule filter, provider-agnostic scoring with Gemini + Ollama (`LLM_PROVIDER`), `src/pipeline/` (filter → score → persist, sender history), `src/queue/` (BullMQ queue, worker, retry policy), `src/worker/main.ts`, and `npm run demo` (`src/demo/`).

Decided after Phase 3: no LLM tool calling. The original plan had the scorer calling `get_user_criteria()` and `get_sender_history(email)` as tools. Instead the worker fetches both from Postgres before the call and puts them in the prompt, so it stays one request per email. Reasons: the Gemini free tier allows 20 requests/day per model, tool calls would take 2–3 requests per email, and small Ollama models are unreliable at tool calls.

## Commands

- `npm test`: unit tests, fully mocked, no infrastructure needed.
- `npm run test:int`: integration tests against real Postgres + Redis (`docker compose up -d --wait` first). Uses the `sifter_test` database and Redis DB 1, never dev data. The LLM is mocked.
- `npm run demo`: seeds synthetic emails into the `sifter_demo` database, runs them through the real queue + worker, prints a score table. Offline canned LLM replies by default; `-- --live` uses the configured provider.
- `npm run test:live`: opt-in real LLM calls with synthetic emails. Gemini's free tier allows 5 requests/min and 20/day per model, and it often returns 503s; skipped for now.
- Docker CLI needs `export PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"` on this machine.

## Phases not built (future work)

5. Gmail OAuth + poller (every 15 min, gmail_id as idempotency key)
6. Notifier interface + Telegram bot (👍/👎 buttons + POST /telegram/webhook, verify secret token) + tests
7. Daily email digest (scored >= threshold in last 24h, grouped by category, sorted by score) + tests
8. GET /metrics + logging (processed, % filtered, LLM latency, failure rate, notifications per channel, precision)
9. Eval harness (~30 fake labeled emails, precision/recall) + GitHub Actions CI
10. Deploy config (Railway or Fly.io). The README with the Mermaid diagram was written at wrap-up.

### Phase 4 details (built)

- Worker runs filter → score → persist.
- Before scoring, the worker loads `user_criteria` and the sender's recent history (last few scored emails from that address, with any 👍/👎 feedback) and passes both into the prompt.
- Retry with exponential backoff, using `retryAfterMs` from provider errors when present.
- Invalid LLM JSON: re-prompt once, then dead-letter and write to `job_failures`.
- Respect `LLM_RATE_LIMIT_PER_MIN` via BullMQ's limiter.
- Idempotency via `gmail_id` ON CONFLICT.
- Integration tests with a mocked LLM against real Postgres + Redis from docker compose.
