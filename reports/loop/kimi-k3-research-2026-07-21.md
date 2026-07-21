# Kimi-K3 for in-app LLM work — research memo (task #15, offline phase)

Owner directive 2026-07-20: research and create an experiment using kimi-k3 for ALL in-app LLM
work (decide + reflection); the daily loop stays on Claude regardless of outcome. This memo is the
research deliverable; the offline replay run is specified below and blocked on one owner input
(API key). Written 2026-07-21 during the v3 demo soak (no app changes made).

## Model facts (as of 2026-07-21 — the model is 5 days old)

- Kimi K3, Moonshot AI, released 2026-07-16: 2.8T-parameter MoE, open-weight (full weights
  announced for ~2026-07-27), native vision, 1,048,576-token context, always-on "thinking mode".
- Positioning: the largest open-weight model shipped to date; benchmark claims put it at/near
  frontier — treat vendor claims as unverified until the replay run scores OUR task.

## Pricing (vendor-published)

| | input/Mtok | output/Mtok | cache-hit input/Mtok |
| --- | --- | --- | --- |
| kimi-k3 | $3.00 | $15.00 | $0.30 |
| claude-sonnet-5 (current, `.env.app` prices) | $3.00 | $15.00 | $0.30 |

Headline rates are IDENTICAL to the incumbent — the experiment's cost axis therefore hinges on
(a) cache-WRITE pricing (unpublished in what I could verify; sonnet-5 bills $6/Mtok — the batched
consult's stable prefix leans hard on cache writes) and (b) thinking-token consumption under
"always-on thinking" (K3 may spend more output tokens per decide). Both are measured, not
assumed, by the replay run. Rate limits: tier-based, confirmable only at key provisioning.

## Endpoint compatibility (the kimi-k2 precedent holds)

- Native API is OpenAI-compatible: `https://api.moonshot.ai/v1` (platform docs relocated to
  `platform.kimi.ai`; the api.moonshot.ai host remains the documented base).
- An **Anthropic-compatible `/anthropic` endpoint is confirmed for K3** (the same mechanism the
  kimi-k2 era established; documented via the Claude-Code-with-Kimi pattern:
  `ANTHROPIC_BASE_URL` + API key, thinking mapped through `thinking.type` /
  `output_config.effort`).
- In-app integration surface is SMALL: `anthropic-agent-client.ts` is a raw-fetch Anthropic
  Messages implementation with an existing `cfg.baseUrl` seam
  (`anthropic-agent-client.ts:1630` — `this.cfg.baseUrl ?? 'https://api.anthropic.com'`).
  Missing plumbing is config-only: an `AGENTIC_BASE_URL` env knob wired into the module's client
  construction, a `KIMI_API_KEY` secret (`.env`, owner-managed), a kimi-k3 row in
  `AGENTIC_TOKEN_PRICES_JSON` (the pricer already fails CLOSED to most-expensive-configured for
  unknown models), and the `anthropic-version` header accepted as-is by the compat endpoint.

## Tool-use fidelity — the open question the replay answers

The Anthropic-compat endpoint demonstrably handles `tool_use` blocks (Claude Code exercises that
surface heavily). UNVERIFIED for our purposes: strict-schema adherence on the unified
`submit_portfolio` contract (deeply nested per-symbol actions, capability flags, decimal-string
money fields) and refusal-free JSON emission over long contexts. This is precisely what the
offline replay measures — no integration decision before those numbers exist.

## Offline experiment design (R1 replay harness, candidate-model-eval pattern)

Harness: `pnpm eval:candidates` (`test/eval/agentic/candidate-model-eval.spec.ts`) — replays
recorded live payloads against candidate models; env-gated (`EVAL_CANDIDATES=1`), off the
production test gate.

1. **Prerequisite A (owner):** a Moonshot/Kimi API key in `.env` as `KIMI_API_KEY`. I do not
   create accounts or handle credential issuance; provisioning also reveals the account's rate
   tier.
2. **Prerequisite B (small harness extension, post-soak or as an isolated eval-lane commit):**
   per-model base-URL + key routing in the harness (today it reads one `ANTHROPIC_API_KEY` and
   hits the default host; needs `AGENTIC_EVAL_BASE_URL`/per-model key map so
   `AGENTIC_EVAL_CANDIDATE_MODELS=kimi-k3` routes to the compat endpoint). Diff shape mirrors the
   client's existing `baseUrl` seam.
3. **Run:** kimi-k3 vs the claude-sonnet-5 baseline over the same recorded payload set
   (`ROW_LIMIT=50` default window; raise if variance is high).
4. **Metrics (same as the e2 model-eval precedent):** schema-valid rate, action agreement with
   baseline, forward-return proxy on disagreements, cost/decide (incl. thinking tokens),
   latency p50/p95.
5. **Recording:** every scored variant to the append-only `experiments` registry; go/no-go
   documented in `state.md`.
6. **Go bar (owner plan, verbatim intent):** ONLY on a clear offline win → staged live-demo A/B
   through the champion/candidate attribution machinery with a two-step enable + WATCH — never a
   mid-window silent model swap. Config via `AGENTIC_MODEL`/`AGENTIC_REFLECTION_MODEL` +
   `AGENTIC_TOKEN_PRICES_JSON` + the new secret.

## Risks / considerations

- **Maturity:** the model and its serving stack are days old; compat-endpoint quirks (header
  handling, streaming, cache_control semantics) may still be shifting. The replay run is immune
  (no production exposure); the live A/B bar filters residual risk.
- **Data residency:** consult payloads contain market data, book state, and playbook text — no
  secrets, no PII, no keys. Sending them to a non-Anthropic provider is a scope the owner
  implicitly opened by commissioning the experiment; flagged here for completeness.
- **Cache economics:** the batching client's cost model leans on prompt caching; if the compat
  endpoint's `cache_control` handling or cache-write pricing differs materially, cost/decide can
  diverge from headline parity — measured by the run.
- **Self-hosting** (open weights land ~07-27) is out of scope: a 2.8T MoE is not economical
  against a $1k book.

## Status

Research phase DONE (this memo). Offline run BLOCKED on Prerequisite A (owner key); Prerequisite
B is a small eval-lane diff prepared after the soak or as an isolated commit. No app changes made
during the soak.

Sources: [Moonshot/Kimi platform docs](https://platform.kimi.ai/docs/api/overview),
[Kimi K3 API guide (Verdent)](https://www.verdent.ai/guides/agents/kimi-k3-api-guide),
[Kimi API overview (Morph)](https://www.morphllm.com/kimi-api),
[VentureBeat release coverage](https://venturebeat.com/technology/chinas-moonshot-ai-releases-kimi-k3-the-largest-open-source-model-ever-rivaling-top-u-s-systems),
[K3 pricing roundup (eesel)](https://www.eesel.ai/blog/kimi-k3-pricing).
