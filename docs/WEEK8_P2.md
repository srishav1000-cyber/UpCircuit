# Week 8 · P2 (turn 39)

| Item | Where | Verified |
|---|---|---|
| Event log with Kafka semantics + exactly-once consumer + replay | `docs/ENTERPRISE_SCHEMA_P2.sql`, `app/api/worker/events`, cron in `vercel.json` | `scripts/rls-test.sh` → 104 assertions |
| Kafka demo (optional) / scale-out path | `deploy/docker-compose.kafka.yml`, `scripts/kafka-demo.mjs`, `docs/SCALE_OUT.md` | **Not run** (no Docker in the build sandbox) |
| Backup / restore drill | `scripts/backup-drill.sh` | Passed: counts, audit head hash, chain recompute, RLS isolation identical after `pg_restore` |
| Command palette (Ctrl/⌘ K) | `components/CommandPalette.tsx`, `lib/palette.ts` | unit + browser e2e |
| Saved layouts (view + lens + density; local + `preferences.layouts`) | `lib/layouts.ts`, `lib/cloud.ts` | unit + browser e2e (cloud save/apply/delete) |
| Accessibility audit (axe-core, WCAG 2.1 A/AA) | `scripts/a11y.cjs`; also run inside logged-in e2e | 0 serious/critical on public pages, palette, terminal + watchlist, compliance, backtest |
| Prediction back-test | `lib/backtest.ts`, `components/PredictionBacktest.tsx` (Compliance → “Prediction back-test”) | unit + browser; runs on real daily bars only |
| Threat model + runbook | `docs/THREAT_MODEL.md`, `docs/RUNBOOK.md` | review documents |

## A11y fixes made
Muted text and brand-blue text contrast on dark; red/green chips; RSI heat tiles; label-in-name on the nav, index and focus tiles; `role=meter` without a value; invalid `tablist` children in the watchlist (now a labelled group of toggle buttons); palette focus + Esc + focus trap.
Excluded from automated contrast checks (transient animation frames): `.animate-pulse`, `.tick-flash`. Not covered: screen-reader walkthroughs, zoom/reflow at 400 %, every modal; automated tools catch roughly a third of WCAG issues.

## Back-test: how to read it
Signal = daily close within 1.5 % of its inferred 5/10/20 % band; hit = next day touches the same band again; baseline = unconditional touch rate over all stock-days; lift = precision ÷ baseline. Nothing is fitted. It warns when < 30 signals. Daily bars hide intraday proximity, the band is inferred, a year is a small sample, and results apply only to the symbols you choose. It is evidence about a heuristic, not a trading claim.

## Honest limits
The event log is Postgres, not Kafka. The drill is a logical dump/restore on synthetic data, not a Supabase PITR test. CI does not yet run the drill (needs Postgres 16 binaries on the runner).
