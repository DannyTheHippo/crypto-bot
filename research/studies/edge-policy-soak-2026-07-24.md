# EdgePolicy residual20-volbeta — 3h soak (check-and-fix)

## Clock

- **Family:** `residual20-volbeta` (owner override of tournament gate fail)
- **Soak T+0 (restart after recon fix):** 2026-07-24T15:46:59Z (boot `11673f15`)
- **Cadence:** 30 minutes × 7 checks (T+0 … T+180)
- **Rule:** any code/config/ops defect → fix → redeploy → **new T+0** (no elapsed credit)

## Checks

Each tick: `pnpm loop:sweep` + edge probes (cohort log, flags, kill switch, recon both venues, RSS, LLM budget, decide liveness) + fix if dirty.

## History

| Check | UTC | Verdict | Notes |
| --- | --- | --- | --- |
| pre | 2026-07-24T15:39Z | DIRTY | boot `51a98ca2`; adopt_non_adoptable + adopt_query_failure; stranded ACKED SELLs |
| fix | 2026-07-24T15:44Z | shipped | venue-filter adopt + closed→myTrades backfill |
| T+0 | 2026-07-24T15:46:59Z | CLEAN | boot `11673f15`; both venues CLEAN recon; edge cohort KAITO/UNI long, TRUMP/HYPE short; kill RUNNING; budget $3 |
| T+30 | 2026-07-24T16:17:45Z | CLEAN | same boot `11673f15`; recon clean both venues (~32/31); kill RUNNING; EdgePolicy on; budget ~$2.83; RSS ~752MiB; alarms=0 |
| T+60 | 2026-07-24T16:47:51Z | CLEAN | same boot; recon clean 61/61; kill RUNNING; EdgePolicy on; budget ~$2.83; RSS ~754MiB; decides+80; alarms=0 |
| T+90 | 2026-07-24T17:17:09Z | CLEAN | same boot; recon clean 90/90; kill RUNNING; EdgePolicy on; cohort still KAITO/UNI×TRUMP/HYPE; budget ~$2.77; RSS ~757MiB; 80 decides/30m; alarms=0 |

## Loop

- interval: 30m
- PID: 44691
- sentinel: `AGENT_LOOP_TICK_edge_soak`
- log: `research/studies/edge-policy-soak-2026-07-24.md` (canonical)
- next tick: T+120 (~17:47Z)
- remaining checks: T+120 … T+180 (3)
- PASS requires seven consecutive CLEAN in this uninterrupted window on boot `11673f15`
