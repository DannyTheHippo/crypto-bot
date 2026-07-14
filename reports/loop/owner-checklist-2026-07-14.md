# Owner checklist — what I need from you for optimal demo performance

Written 2026-07-14 (Push 3 close-out). Scope: the two DEMO lanes (spot + futures-demo). No real
money is involved in anything below. Everything is split by whether it needs you.

## (A) Already applied and live — NO action needed

Both lanes are deployed at HEAD, healthy, and running. You do not need to touch any of this.

- **Spot lane** (`app`, port 3100): the whole Push II + Push 3 feature set is live —
  LIMIT_MAKER entries, 0.05 equity sizing, venue-resting take-profit, portfolio consult, the five
  info channels (most flag-off in the measured-rollout queue), and as of today the **info×thinking
  factorial** (`AGENTIC_DERIVATIVES_AB_PCT=50`, `AGENTIC_THINKING_AB_PCT=50`). Migration 0012
  (A/B arm journaling) applied at boot.
- **Perp lane L0** (`app-perp`, port 3102): NEW this session. Futures-demo (binanceusdm/demo,
  `demo-fapi`), BTC/USDT:USDT only, LONGS-ONLY, full stop architecture on (venue TP + venue
  STOP_MARKET on the algo rail + executor stop + S3 backstop), leverage 1 isolated, $2/day LLM
  breaker, own isolated Postgres (5433) + Prometheus (9091). Currently in WARMUP — it needs ~340
  15-minute bars (≈3.5 days of awake host time) before it makes its first decision.

Rollback for any of it is a flag flip, not a revert — I designed every enable that way.

## (B) Verify once — env vars (I confirmed all the required ones are present today)

These live in `.env` (never in git). I verified the required three are set this session; listing
them so you can confirm they are the RIGHT keys and stay valid:

| Var | Status | Note |
| --- | --- | --- |
| `BINANCE_DEMO_API_KEY` / `BINANCE_DEMO_API_SECRET` | set ✓ | Binance Demo Trading keys, cover BOTH spot and futures-demo on one account. **Withdrawals must be disabled on these keys** (a live gate requirement, harmless for demo but keep it true). Shared by both lanes. |
| `ANTHROPIC_API_KEY` | set ✓ | Drives both lanes' agents. The only recurring real cost. Guarded by per-lane daily breakers ($5 spot / $2 perp). |
| `SENTIMENT_FEED_API_KEY` | NOT set | OPTIONAL. Only needed if/when the sentiment info-channel is enabled (it is off, sitting in the post-factorial queue). No action unless you want that channel — then a free CryptoPanic key. |

Nothing else in `.env` needs you. The lanes share one `.env` via `env_file`.

## (C) Genuine owner-only actions — the real asks

1. **Keep the host awake (THE standing dependency).** The stack runs on your MacBook. Host sleep
   throttles everything — the perp lane's 3.5-day warmup, the factorial's trip accumulation, and
   the daily loop all measure in *awake* hours. Please keep the Mac on AC power with sleep
   disabled and auto-login on, and set Docker Desktop to "start at sign-in." (Or move the stack to
   an always-on host — the compose is portable and the DB backups cover the move.) This is the
   single biggest lever on "optimal performance," and it is the one thing I cannot do for you.
2. **Nothing else** for demo. The live-money flip is the only other human touchpoint by policy,
   and it is not part of demo operation — do not arm live.

## (D) Deliberately NOT enabled yet — and the exact trigger that flips each

All of these are loop-domain: the daily loop applies them itself once the trigger holds. None
needs you. Listed so you know what is coming and why it is gated.

| Item | Currently | Trigger to enable (loop applies it) |
| --- | --- | --- |
| Perp SHORTS (L0→L1) | off (`AGENTIC_SHORTS_ENABLED=false`) | perp L0 soak: ≥3 days clean AND ≥5 closed perp trips AND zero reconciliation mismatches AND the algo-rail stop lifecycle verified live |
| Spot 1s stop watcher | off | re-run the stop-slippage study at N≥10 spot stop-exits; enable only if the leak clears the pre-registered bar (the perp lane's venue stop already supersedes it there) |
| Post-factorial info channels (track-record, derivatives-v2, liquidations, book-structure, sentiment) | built, off | after the factorial verdict — then one measured channel at a time |
| Spot symbol expansion 5→8 (ZEC/AAVE/NEAR) | 5 symbols | after a clean ≥2-day portfolio-consult soak |
| Perp symbol expansion (L1→L2) | 1 symbol | after L1 shows ≥5 clean short trips |

## What to watch (the loop owns these; for your awareness)

- **Factorial (spot):** new decide rows stamping non-null `info_arm`/`thinking_arm`; all four A/B
  cells filling; daily spend under $4.50 (else thinking auto-drops 50→30).
- **Perp L0 — first live exercise of the algo-rail stop anywhere:** first entry places a resting
  STOP_MARKET visible via the algo endpoints; a `venue_stop_filled` journal row; and critically
  NO reconciliation HALT (a HALT would mean the algo-rail containment missed a case — it stops the
  lane rather than mishandling money, by design; investigate before re-arm).

## Bottom line

To get optimal demo performance from what is now deployed, the only thing I need from you is
**(C1): keep the host awake and Docker running.** Everything else is either already applied or
gated behind evidence the loop will collect on its own.
