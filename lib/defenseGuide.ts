// Viva / examiner walkthrough: the five capstone contributions, where to find each on the Surveillance Desk, the exact formulas and the honest caveats.
import { CONFIRM_PARAMS, FLAG_PARAMS } from './heuristicFlags';

export interface DefenseCheckpoint { id: string; n: number; title: string; targetId: string; summary: string; formulas: string[]; caveats: string[] }

export const DEFENSE_CHECKPOINTS: readonly DefenseCheckpoint[] = [
  {
    id: 'daemon', n: 1, title: 'Live SmartAPI & 24/7 Lease Daemon', targetId: 'desk-sec-daemon',
    summary: 'An always-on Render worker keeps the SmartAPI feed, evaluates alert rules and writes heartbeats; a warm standby takes over if the leader dies. The panel shows the feed state, tick lag and both heartbeats.',
    formulas: ['lease: exactly one holder of daemon_leases may write; epoch (fencing token) = previous epoch + 1 on every change of leader', 'failover time ≈ lease TTL + standby poll interval (≲ 40 s after a crash in the smoke test)', 'tick lag = now − newest tick time; leader heartbeat stale when age > 20 s'],
    caveats: ['A free Render instance can sleep unless the /health keep-alive is pinged; the standby only helps while it is itself running.', 'Outside 09:15–15:30 IST the feed is idle by design, not broken.', 'When SmartAPI is not connected the terminal falls back to delayed Yahoo data and labels it so.'],
  },
  {
    id: 'obi-volume', n: 2, title: '15-Min Volume Baseline & Weighted OBI', targetId: 'desk-sec-obi',
    summary: 'Order-book imbalance over the top five levels, with weights that decay by distance from the touch, plus a rolling 15-minute volume ratio against the stock’s own typical intraday profile.',
    formulas: ['OBI_λ = Σᵢ wᵢ(Bᵢ − Aᵢ) ÷ Σᵢ wᵢ(Bᵢ + Aᵢ),  wᵢ = e^(−λ(i−1)),  i = 1…5,  λ = 0.5', 'R(t) = [V(t) − V(t−15 min)] ÷ [E(t) − E(t−15 min)],  E = median cumulative profile over ≥ 10 sessions (25 buckets of 15 min)', `wall: level ≥ ${FLAG_PARAMS.WALL_MULT}× the median of the other levels on its side`],
    caveats: ['Depth is only available while the market is open and streaming; every depth figure is N/A otherwise.', 'R(t) is N/A for the first 5 minutes after the open and for stocks without a baseline.', 'OBI measures resting orders, not intent.'],
  },
  {
    id: 'ablation', n: 3, title: 'Multi-Signal Precision Ablation & Threshold Explorer', targetId: 'desk-sec-ablation',
    summary: 'Each corroborating signal alone versus combined on the 539,972-snapshot synthetic benchmark, with an interactive explorer over λ, wall multiple and R(t).',
    formulas: [`confirmed = at least ${CONFIRM_PARAMS.MIN_SIGNALS} of 3: |OBI_λ| ≥ ${CONFIRM_PARAMS.OBI_MIN}, R(t) ≥ ${CONFIRM_PARAMS.SURGE_MIN}, spread ≥ ${CONFIRM_PARAMS.SPREAD_MULT}× rolling median`, 'precision = TP ÷ (TP+FP);  recall = detected episodes ÷ labelled episodes;  F1 = 2PR ÷ (P+R)', 'FP reduction = (FP_baseline − FP) ÷ FP_baseline'],
    caveats: ['Synthetic data: results describe agreement with the generator’s labels, not real-market manipulation.', 'The volume↔episode link is an assumption; the sensitivity runs show the composite without it.', 'The composite trades recall for precision; on this benchmark OBI alone has the best F1 — the table says so.'],
  },
  {
    id: 'sandbox', n: 4, title: 'Live Market Burst Replay Sandbox', targetId: 'desk-sec-sandbox',
    summary: 'A scripted three-stock burst is pushed through the real flag, imbalance and volume code at any hour: RELIANCE gets a Multi-Signal Confirmed wall, TCS a Baseline-only wall, INFY touches its upper circuit.',
    formulas: ['same OBI_λ and R(t) formulas as the live desk', 'simulated alert rules: R(t) ≥ 1.8 · |OBI_λ| ≥ 0.6 · within 1.5 % of the circuit · any confirmed flag (5-minute cooldown per rule)'],
    caveats: ['Synthetic ticks and depth, labelled SIMULATION; nothing is stored and no real alert is sent.', 'The “push” is a local chime and an on-screen row.'],
  },
  {
    id: 'audit', n: 5, title: 'SEBI White-Box Audit Pack Export', targetId: 'desk-sec-audit',
    summary: 'One click downloads a JSON dossier and opens a printable report: session metadata, daemon HA state, alert rules and quiet hours, delivery latency, live readings, the daily digest and every formula used.',
    formulas: ['integrity seal = SHA-256 over the canonical JSON without the integrity block', 'slippage: VWAP = Σ pᵢqᵢ ÷ Σ qᵢ over the 5 levels walked;  slippage = VWAP − best price (₹ and bps)'],
    caveats: ['Written to the white-box / audit-trail principles of SEBI’s 2026 algo-oversight direction; it does not claim SEBI compliance or approval.', 'A record of an analytics tool; UpCircuit is not a SEBI-registered Investment Adviser or Research Analyst and nothing in it is advice.', 'Secrets are redacted from the file.'],
  },
];
