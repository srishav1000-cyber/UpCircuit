// Institutional research note (Markdown). Every figure carries its source and the timestamp of the note; N/A is written as N/A.
import type { PeerRow } from './peerTable';

export interface NoteInput {
  symbol: string;
  name: string;
  sector: string;
  ltp: number;
  changePct: number;
  feed: 'SmartAPI Live' | 'Yahoo Delayed';
  now: Date;
  fundamentals: { label: string; value: string; source: string }[];
  peers: PeerRow[];
  valuation: { label: string; value: string; source: string }[];
  risk: { label: string; value: string; source: string }[];
}

const stamp = (d: Date) => d.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' }) + ' IST';
const cell = (s: string) => s.replace(/\|/g, '/');

export function buildResearchNote(n: NoteInput): string {
  const t = stamp(n.now);
  const tbl = (rows: { label: string; value: string; source: string }[]) => ['| Metric | Value | Source |', '|---|---|---|', ...rows.map((r) => `| ${cell(r.label)} | ${cell(r.value)} | ${cell(r.source)} |`)].join('\n');
  const peerHead = '| Symbol | Mkt cap ₹ Cr | P/E | ROE % | D/E | Div yld % | 1Y return % | 1Y vol % | Sharpe | Value quartile |\n|---|---|---|---|---|---|---|---|---|---|';
  const peerRows = n.peers.map((p) => `| ${p.symbol === n.symbol ? '**' + p.symbol + '**' : p.symbol} | ${p.cells.mcap} | ${p.cells.pe} | ${p.cells.roe} | ${p.cells.de} | ${p.cells.dy} | ${p.cells.ret} | ${p.cells.vol} | ${p.cells.sharpe} | ${p.valueQuartile ?? 'N/A'} |`);
  return [
    `# Research note — ${n.name} (${n.symbol})`,
    `*Sector: ${n.sector} · Generated ${t} · Price ₹${n.ltp.toFixed(2)} (${n.changePct >= 0 ? '+' : ''}${n.changePct.toFixed(2)}%) · Feed: ${n.feed}*`,
    '',
    '## 1. Fundamentals',
    tbl(n.fundamentals),
    '',
    '## 2. Valuation context',
    tbl(n.valuation),
    '',
    '## 3. Peer comparison',
    peerHead,
    ...peerRows,
    '',
    'Quartiles rank peers with real data only (Q1 = best 25 %). Lower is better for P/E, D/E and volatility; higher is better for ROE, yield, return and Sharpe. Missing values show N/A and are excluded from ranking.',
    '',
    '## 4. Risk and return',
    tbl(n.risk),
    '',
    '## 5. Data provenance and limitations',
    `- Prices: ${n.feed}. Fundamentals: Yahoo Finance via the app's fundamentals provider; fields it does not supply are N/A, never estimated.`,
    '- Computed Math items use the formulas in the app\'s Methodology panel (Rf 6.5 %, 252 trading days, one-year daily closes).',
    '- Valuation is judged against peers today: the provider does not supply historical P/E, so no own-history P/E percentile is shown.',
    `- This note is generated analytics for a student capstone, produced ${t}. It is not investment advice or a SEBI-registered research report.`,
    '',
  ].join('\n');
}
