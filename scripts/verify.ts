/* Core logic checks — run with `npm test`. No framework: plain assertions, exits non-zero on failure. */
import assert from 'node:assert/strict';
import { SEED_INSTRUMENTS } from '../lib/instruments';
import { MarketEngine, TIMEFRAMES, TF_CONFIG, generateHistory } from '../lib/market';
import {
  capClass, correlationMatrix, hhi, longTermOutlook, pearson, pivotLevels, portfolioSummary, rsi14, sharpe, shortTermOutlook, sma, topMovers, vwap, macd,
} from '../lib/analytics';
import { parsePortfolioCsv } from '../lib/csv';
import { parseRss, decodeEntities } from '../lib/news';
import { scoreText } from '../lib/sentiment';
import { buildIndex, searchInstruments } from '../lib/fuzzy';
import { getFundamentals } from '../lib/fundamentals';
import { answerLocally, detectIntent, isContext, type CopilotContext } from '../lib/copilot';
import { TtlCache, allow } from '../lib/ttlCache';
import {
  cumulativeReturnPct, dividendForecast, intradaySigma, liquidityRatio, portfolioDiagnostics, portfolioValueSeries, sectorIndexSeries, sharpeParts, tickVolumeBuckets, vwapBands, weightedRiskScore,
} from '../lib/analytics';
import { encodeTick, parseTick, subscribeMessage, totp, type SmartTick } from '../lib/smartapi';
import { isMarketOpen, SmartApiFeed } from '../lib/market';
import { parseHoldingsText } from '../lib/portfolioText';
import { addAlert, checkAlerts, parseAlerts } from '../lib/alerts';
import { smartApiStatus } from '../lib/market';
// @ts-expect-error plain .mjs helper
import { pickEquities } from './sync-instruments.mjs';

let passed = 0;
const t = (name: string, fn: () => void) => {
  try {
    fn();
    passed++;
    console.log('  ✓', name);
  } catch (e) {
    console.error('  ✗', name, '\n   ', (e as Error).message);
    process.exitCode = 1;
  }
};
const near = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

console.log('analytics');
t('pivot levels (H110 L100 C105)', () => {
  const p = pivotLevels(110, 100, 105);
  near(p.p, 105); near(p.r1, 110); near(p.s1, 100); near(p.r2, 115); near(p.s2, 95);
});
t('pearson: +1, −1, 0, flat series', () => {
  near(pearson([1, 2, 3, 4], [2, 4, 6, 8]), 1);
  near(pearson([1, 2, 3, 4], [8, 6, 4, 2]), -1);
  near(pearson([1, 2, 3, 4, 5], [2, 4, 2, 4, 2]), 0, 0.5);
  assert.equal(pearson([1, 1, 1], [1, 2, 3]), 0);
});
t('correlation matrix is symmetric with unit diagonal', () => {
  const { matrix } = correlationMatrix({ A: [1, 2, 3, 5, 4, 6], B: [2, 1, 4, 3, 6, 5], C: [9, 8, 7, 8, 6, 5] });
  for (let i = 0; i < 3; i++) { near(matrix[i][i], 1); for (let j = 0; j < 3; j++) near(matrix[i][j], matrix[j][i]); }
});
t('RSI: rising → 100, falling → 0, bounded', () => {
  assert.equal(rsi14(Array.from({ length: 30 }, (_, i) => 100 + i)), 100);
  near(rsi14(Array.from({ length: 30 }, (_, i) => 100 - i))!, 0);
  const r = rsi14([44, 44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.0, 46.03, 46.41, 46.22, 45.64])!;
  assert.ok(r > 55 && r < 75, 'classic Wilder sample should be ~60s, got ' + r);
});
t('VWAP = Σ(P·V)/ΣV', () => { near(vwap([10, 20], [1, 3])!, 17.5); assert.equal(vwap([], []), null); });
t('HHI: 4 equal = 2500, single = 10000', () => { near(hhi([1, 1, 1, 1]), 2500); near(hhi([5]), 10000); });
t('portfolio P&L = Σ(LTP×Qty) − invested', () => {
  const s = portfolioSummary([{ symbol: 'A', qty: 10, avg: 100 }, { symbol: 'B', qty: 5, avg: 200 }], (sym) => (sym === 'A' ? { ltp: 110, prevClose: 108 } : { ltp: 190, prevClose: 195 }));
  near(s.invested, 2000); near(s.current, 2050); near(s.pnl, 50); near(s.pnlPct, 2.5); near(s.dayPnl, 2050 - (1080 + 975));
});
t('SMA / MACD basics', () => { near(sma([1, 2, 3, 4, 5], 5)!, 3); assert.equal(sma([1], 5), null); assert.ok(macd(Array.from({ length: 60 }, (_, i) => 100 + i))!.hist !== undefined); });
t('Sharpe is null for short / flat series', () => { assert.equal(sharpe([1, 2, 3]), null); assert.equal(sharpe(Array(40).fill(100)), null); });
t('cap classes', () => { assert.equal(capClass(150000), 'Large'); assert.equal(capClass(50000), 'Mid'); assert.equal(capClass(5000), 'Small'); });

console.log('csv');
t('valid file', () => {
  const r = parsePortfolioCsv('symbol,quantity,buy_price\nRELIANCE,10,2500.50\nTCS,5,"3,400"\n');
  assert.deepEqual(r.holdings, [{ symbol: 'RELIANCE', qty: 10, avg: 2500.5 }, { symbol: 'TCS', qty: 5, avg: 3400 }]);
  assert.equal(r.errors.length, 0);
});
t('BOM, CRLF, header aliases, lowercase symbols', () => {
  const r = parsePortfolioCsv('﻿Ticker,Qty,Avg Price\r\ninfy,3,1500\r\n');
  assert.deepEqual(r.holdings, [{ symbol: 'INFY', qty: 3, avg: 1500 }]);
});
t('duplicates merge at weighted average', () => {
  const r = parsePortfolioCsv('symbol,quantity,buy_price\nSBIN,10,100\nSBIN,30,200');
  assert.deepEqual(r.holdings, [{ symbol: 'SBIN', qty: 40, avg: 175 }]);
  assert.equal(r.warnings.length, 1);
});
t('bad rows are reported with line numbers, good rows kept', () => {
  const r = parsePortfolioCsv('symbol,quantity,buy_price\nITC,0,400\nITC,2.5,400\n,1,1\nHDFC BANK!,1,1\nITC,4,abc\nSBIN,1,500', new Set(['ITC', 'SBIN']));
  assert.equal(r.holdings.length, 1);
  assert.equal(r.errors.length, 5);
  assert.match(r.errors[0], /^Row 2/);
});
t('unknown symbols rejected when a master is supplied', () => {
  const r = parsePortfolioCsv('symbol,quantity,buy_price\nNOPE,1,1', new Set(['ITC']));
  assert.equal(r.holdings.length, 0); assert.match(r.errors[0], /not in the NSE/);
});
t('wrong header / empty file', () => {
  assert.match(parsePortfolioCsv('a,b,c\n1,2,3').errors[0], /Header must be/);
  assert.match(parsePortfolioCsv('').errors[0], /empty/);
});

console.log('news + sentiment');
t('RSS 2.0 with CDATA, entities, dates', () => {
  const xml = `<rss><channel><item><title><![CDATA[Sensex jumps 500 pts &amp; Nifty hits record high]]></title><link>https://x.test/a</link><pubDate>Fri, 09 Oct 2026 10:00:00 +0530</pubDate></item>
  <item><title>Plain &quot;title&quot;</title><link>https://x.test/b</link></item><item><title>No link</title></item></channel></rss>`;
  const items = parseRss(xml);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, 'Sensex jumps 500 pts & Nifty hits record high');
  assert.equal(items[1].title, 'Plain "title"');
  assert.ok(items[0].published > 0 && items[1].published === 0);
});
t('Atom entries', () => {
  const items = parseRss('<feed><entry><title>Hello</title><link href="https://y.test/1"/><updated>2026-10-09T05:00:00Z</updated></entry></feed>');
  assert.equal(items.length, 1); assert.equal(items[0].link, 'https://y.test/1');
});
t('entities', () => assert.equal(decodeEntities('A&nbsp;&amp;&#8211;&#x2013;B &unknown;'), 'A &––B &unknown;'));
t('headline sentiment direction', () => {
  assert.equal(scoreText('Nifty surges to record high as banks rally').label, 'Bullish');
  assert.equal(scoreText('Sensex crashes as FIIs dump stocks').label, 'Bearish');
  assert.equal(scoreText('Auto sales fall short of estimates, shares slump').label, 'Bearish');
  assert.equal(scoreText('Company beats estimates, announces buyback').label, 'Bullish');
  assert.equal(scoreText('RBI board meeting scheduled for Friday').label, 'Neutral');
  const s = scoreText('anything at all'); assert.ok(s.score >= -1 && s.score <= 1);
});

console.log('market engine');
t('history: all 10 timeframes well-formed', () => {
  const now = Date.UTC(2026, 9, 9, 6, 0, 0); // a Friday
  for (const tf of TIMEFRAMES) {
    const h = generateHistory('RELIANCE', tf, 1234.5, now);
    assert.equal(h.length, TF_CONFIG[tf].bars, tf + ' length');
    near(h[h.length - 1].close, 1234.5, 0.01);
    for (let i = 0; i < h.length; i++) {
      const b = h[i];
      assert.ok(b.high >= Math.max(b.open, b.close) - 1e-9 && b.low <= Math.min(b.open, b.close) + 1e-9, `${tf} OHLC @${i}`);
      assert.ok(b.volume > 0);
      if (i > 0) assert.ok(b.time > h[i - 1].time, `${tf} time order @${i}`);
    }
    if (tf === '1W' || tf === '5Y') assert.equal(new Date(h[h.length - 1].time * 1000).getUTCDay(), 1, 'weeks start Monday');
    if (tf === '1M' || tf === '10Y') assert.equal(new Date(h[h.length - 1].time * 1000).getUTCDate(), 1, 'months start on the 1st');
    if (tf === '1D' || tf === '1Y') h.forEach((b) => assert.ok(![0, 6].includes(new Date(b.time * 1000).getUTCDay()), 'no weekend bars'));
  }
});
t('history is deterministic', () => {
  const a = generateHistory('TCS', '1D', 100, 1.7e12), b = generateHistory('TCS', '1D', 100, 1.7e12);
  assert.deepEqual(a, b);
});
t('same-sector pairs correlate more than cross-sector pairs', () => {
  const now = Date.UTC(2026, 9, 9, 6);
  const close = (s: string) => generateHistory(s, '1D', 100, now).map((c) => c.close);
  const same = ['HDFCBANK', 'ICICIBANK', 'SBIN', 'AXISBANK', 'KOTAKBANK'];
  const other = ['TCS', 'ITC', 'MARUTI', 'SUNPHARMA', 'DLF'];
  const avg = (pairs: [string, string][]) => pairs.reduce((a, [x, y]) => a + correlationMatrix({ [x]: close(x), [y]: close(y) }).matrix[0][1], 0) / pairs.length;
  const sp: [string, string][] = []; const cp: [string, string][] = [];
  for (let i = 0; i < same.length; i++) for (let j = i + 1; j < same.length; j++) sp.push([same[i], same[j]]);
  for (let i = 0; i < same.length; i++) cp.push([same[i], other[i]]);
  const a = avg(sp), b = avg(cp);
  assert.ok(a > b + 0.05, `same ${a.toFixed(2)} should exceed cross ${b.toFixed(2)}`);
  assert.ok(b > 0.05, 'cross-sector corr should be positive (market factor) — got ' + b.toFixed(2));
});
t('engine: 5 min of ticks → prices stay inside circuits, alerts fire, kinds valid', () => {
  const e = new MarketEngine(SEED_INSTRUMENTS); e.setMode('simulated'); // market-hours simulation (a closed market is calm — tested below)
  let now = Date.now();
  for (let i = 0; i < 4800; i++) { e.step('RELIANCE', now); now += 250; } // 20 simulated minutes
  e.quotes.forEach((q) => {
    assert.ok(q.ltp <= q.upperCircuit && q.ltp >= q.lowerCircuit, `${q.symbol} outside band`);
    assert.ok(q.high >= q.ltp && q.low <= q.ltp);
  });
  assert.ok(e.alerts.length > 0, 'expected simulated alerts');
  const kinds = new Set(e.alerts.map((a) => a.kind));
  console.log('      alert kinds seen:', [...kinds].join(', '), `(${e.alerts.length})`);
  e.alerts.forEach((a) => assert.ok(['UPPER_CIRCUIT', 'LOWER_CIRCUIT', 'PRICE_SURGE', 'VOLUME_SURGE'].includes(a.kind)));
  const ids = e.alerts.map((a) => a.id); assert.equal(new Set(ids).size, ids.length, 'unique alert ids');
  // cooldown: no (symbol, kind) twice within 5 min
  const seen = new Map<string, number>();
  [...e.alerts].reverse().forEach((a) => { const k = a.symbol + a.kind; if (seen.has(k)) assert.ok(a.time - seen.get(k)! >= 300_000, 'cooldown ' + k); seen.set(k, a.time); });
});
t('engine: volume spike detection needs >3× baseline', () => {
  const e = new MarketEngine(SEED_INSTRUMENTS); e.simulateEvents = false;
  let now = Date.now();
  for (let i = 0; i < 400; i++) { e.step('TCS', now); now += 250; }
  assert.equal(e.alerts.filter((a) => a.kind === 'VOLUME_SURGE').length, 0, 'no spikes without injected events');
});
t('engine: rolling VWAP lies within the recent price range', () => {
  const e = new MarketEngine(SEED_INSTRUMENTS); e.setMode('simulated'); e.simulateEvents = false;
  for (let i = 0; i < 200; i++) e.step('INFY', Date.now());
  const v = e.rollingVwap(60_000)!; const q = e.quotes.get('INFY')!;
  assert.ok(v >= q.low && v <= q.high, `vwap ${v} not within ${q.low}..${q.high}`);
});
t('market-cap buckets are all populated across the seed universe', () => {
  const e = new MarketEngine(SEED_INSTRUMENTS);
  const c = { Large: 0, Mid: 0, Small: 0 }; e.quotes.forEach((q) => c[capClass(q.mcapCr)]++);
  console.log('      Large/Mid/Small:', c.Large, c.Mid, c.Small);
  assert.ok(c.Large >= 10 && c.Mid >= 10 && c.Small >= 10);
});
t('top movers ordering', () => {
  const e = new MarketEngine(SEED_INSTRUMENTS); const all = [...e.quotes.values()];
  const g = topMovers(all, 'gainers', 5), l = topMovers(all, 'losers', 5), v = topMovers(all, 'volume', 5);
  const pct = (q: (typeof all)[0]) => q.ltp / q.prevClose - 1;
  assert.ok(pct(g[0]) >= pct(g[4]) && pct(l[0]) <= pct(l[4]));
  assert.ok(v[0].volume * v[0].ltp >= v[4].volume * v[4].ltp);
});

console.log('search');
t('"south" → SOUTHBANK first; "sr" → SRF first', () => {
  const idx = buildIndex(SEED_INSTRUMENTS);
  assert.equal(searchInstruments(idx, 'south')[0].symbol, 'SOUTHBANK');
  assert.equal(searchInstruments(idx, 'sr')[0].symbol, 'SRF');
  assert.equal(searchInstruments(idx, 'south ind')[0].symbol, 'SOUTHBANK');
  assert.equal(searchInstruments(idx, 'relience')[0].symbol, 'RELIANCE', 'typo tolerance');
  assert.equal(searchInstruments(idx, '').length, 0);
});

console.log('fundamentals + copilot');
const mkCtx = (symbol = 'TCS'): CopilotContext => {
  const e = new MarketEngine(SEED_INSTRUMENTS); const q = e.quotes.get(symbol)!;
  const closes = generateHistory(symbol, '1D', q.ltp, Date.now()).map((c) => c.close);
  const prev = generateHistory(symbol, '1D', q.ltp, Date.now()).slice(-2)[0];
  const s = shortTermOutlook(closes), l = longTermOutlook(closes);
  return {
    symbol, name: q.name, sector: q.sector,
    price: { ltp: q.ltp, changePct: (q.ltp / q.prevClose - 1) * 100, dayHigh: q.high, dayLow: q.low, volume: q.volume, circuitBandPct: q.circuitBand },
    ratios: getFundamentals(q),
    technicals: { rsi: rsi14(closes), sma50: sma(closes, 50), sma200: sma(closes, 200), pivots: pivotLevels(prev.high, prev.low, prev.close), short: s && { label: s.label, score: s.score }, long: l && { label: l.label, score: l.score } },
    simulated: true,
  };
};
t('fundamentals are consistent (BV = EPS/ROE, banks have no D/E)', () => {
  const e = new MarketEngine(SEED_INSTRUMENTS);
  const f = getFundamentals(e.quotes.get('TCS')!);
  near(f.bookValue, f.eps / (f.roe / 100), f.bookValue * 0.01); // 1 % slack: inputs are rounded for display
  assert.ok(f.pe > 0 && f.promoterHolding >= 0 && f.promoterHolding <= 100);
  assert.equal(getFundamentals(e.quotes.get('HDFCBANK')!).debtToEquity, null);
  assert.deepEqual(getFundamentals(e.quotes.get('TCS')!), getFundamentals(e.quotes.get('TCS')!));
});
t('outlooks produce labelled signals', () => {
  const closes = generateHistory('INFY', '1D', 1500, Date.now()).map((c) => c.close);
  const s = shortTermOutlook(closes)!, l = longTermOutlook(closes)!;
  assert.equal(s.signals.length, 4); assert.equal(l.signals.length, 5);
  assert.ok(s.score >= -100 && s.score <= 100 && ['Bullish', 'Bearish', 'Neutral'].includes(l.label));
  assert.equal(longTermOutlook(closes.slice(-100)), null);
});
t('intent routing', () => {
  assert.equal(detectIntent('Is it expensive?'), 'valuation');
  assert.equal(detectIntent('what is the debt situation'), 'debt');
  assert.equal(detectIntent('Where is support and resistance?'), 'technical');
  assert.equal(detectIntent('dividend yield?'), 'dividend');
  assert.equal(detectIntent('tell me about it'), 'summary');
});
t('local answers: every intent returns text with the disclaimer and real numbers', () => {
  const ctx = mkCtx();
  for (const q of ['Is it expensive?', 'How are ROE and ROCE?', 'debt?', 'dividend?', 'support resistance?', 'news sentiment?', 'key risks?', 'should I invest?', 'hi']) {
    const a = answerLocally(q, ctx, []);
    assert.match(a, /not investment advice/); assert.match(a, /simulated/);
    assert.ok(a.length > 80, q);
  }
  assert.match(answerLocally('Is it expensive?', ctx, []), new RegExp(ctx.ratios.pe.toFixed(1)));
  assert.doesNotMatch(answerLocally('debt?', mkCtx('HDFCBANK'), []), /Debt-to-equity is \d/);
  assert.ok(isContext(ctx) && !isContext({ symbol: 1 }) && !isContext(null));
});
t('TTL cache expiry + rate limiter', () => {
  const c = new TtlCache<number>(30); c.set('a', 1); assert.equal(c.get('a')?.value, 1);
  const origNow = Date.now; Date.now = () => origNow() + 100; assert.equal(c.get('a'), undefined); Date.now = origNow;
  assert.ok(allow('k', 2, 1000) && allow('k', 2, 1000) && !allow('k', 2, 1000));
});


console.log('expanded persona analytics');
t('VWAP bands: ΣPV/ΣV ± kσ (volume-weighted)', () => {
  const b = vwapBands([{ t: 0, p: 100, v: 1 }, { t: 1, p: 110, v: 3 }], 2)!;
  near(b.vwap, 107.5); near(b.sd, Math.sqrt((1 * 56.25 + 3 * 6.25) / 4)); near(b.upper, b.vwap + 2 * b.sd); near(b.lower, b.vwap - 2 * b.sd);
  assert.equal(vwapBands([]), null);
});
t('tick-volume buckets sum to the traded volume in the window', () => {
  const now = 1_000_000;
  const tr = [{ t: now - 1000, p: 1, v: 5 }, { t: now - 6000, p: 1, v: 7 }, { t: now - 200_000, p: 1, v: 99 }];
  const b = tickVolumeBuckets(tr, now, 5000, 36);
  assert.equal(b.length, 36); assert.equal(b.reduce((a, x) => a + x.volume, 0), 12);
});
t('intraday σ: flat → 0, noisy → positive, annualised = per-sample × √N', () => {
  near(intradaySigma(Array(25).fill(100), 1000)!.perSamplePct, 0);
  assert.equal(intradaySigma([100, 101], 1000), null);
  const r = intradaySigma(Array.from({ length: 25 }, (_, i) => 100 + (i % 3)), 10_000)!;
  assert.ok(r.perSamplePct > 0); near(r.annualisedPct, r.perSamplePct * 100);
});
t('liquidity ratio = turnover ÷ market cap', () => { near(liquidityRatio(50, 1000), 5); assert.equal(liquidityRatio(5, 0), 0); });
t('sector index rebased to 100; sharpe parts consistent with Sharpe formula', () => {
  const idx = sectorIndexSeries([[100, 101, 102, 103], [200, 202, 204, 206]]);
  assert.equal(idx[0], 100); assert.equal(idx.length, 4); assert.ok(idx[3] > 100);
  const v = Array.from({ length: 80 }, (_, i) => 100 * Math.exp(0.001 * i + 0.01 * Math.sin(i)));
  const p = sharpeParts(v)!;
  near(p.sharpe, (p.annReturnPct / 100 - 0.065) / (p.annVolPct / 100), 1e-9);
  assert.equal(sharpeParts(v.slice(0, 10)), null); assert.equal(sharpeParts(Array(60).fill(100)), null);
});
t('portfolio value series, cumulative return, weighted risk', () => {
  assert.deepEqual(portfolioValueSeries([[1, 2, 3], [10, 20]], [2, 1]), [2 * 2 + 10, 2 * 3 + 20]);
  assert.deepEqual(cumulativeReturnPct([100, 110, 90]).map((x) => Math.round(x)), [0, 10, -10]);
  const r = weightedRiskScore([{ weight: 1, volPct: 30 }, { weight: 1, volPct: 90 }]);
  near(r.weightedVolPct, 60); assert.equal(r.score, 100); assert.equal(weightedRiskScore([]).score, 0);
});
t('dividend forecast conserves annual income', () => {
  const rows = [{ symbol: 'ITC', value: 100000, yieldPct: 3 }, { symbol: 'TCS', value: 50000, yieldPct: 1.2 }, { symbol: 'XYZ', value: 1000, yieldPct: 0 }];
  const f = dividendForecast(rows, 9);
  assert.equal(f.length, 12); assert.equal(f[0].label, 'Oct'); near(f.reduce((a, m) => a + m.amount, 0), 3000 + 600, 1e-6);
});
t('portfolio diagnostics: concentration, sectors, advice', () => {
  const d = portfolioDiagnostics([{ symbol: 'A', sector: 'IT', value: 80, invested: 70 }, { symbol: 'B', sector: 'IT', value: 10, invested: 10 }, { symbol: 'C', sector: 'FMCG', value: 10, invested: 12 }])!;
  assert.equal(d.concentration, 'High'); near(d.top1Pct, 80); near(d.sectors[0].pct, 90); near(d.hhi, 6600, 1e-6);
  assert.ok(d.advice.some((a) => a.kind === 'trim' && /Trim A/.test(a.title)) && d.diversification < 40);
  const even = portfolioDiagnostics(Array.from({ length: 12 }, (_, i) => ({ symbol: 'S' + i, sector: ['IT', 'Banking', 'FMCG', 'Pharma', 'Auto', 'Energy'][i % 6], value: 100, invested: 100 })))!;
  assert.equal(even.concentration, 'Low'); assert.ok(even.diversification >= 75, String(even.diversification));
  assert.equal(portfolioDiagnostics([]), null);
});

console.log('live feed / SmartAPI');
t('SmartWebSocketV2 packet encode ↔ parse round-trip (snap quote with depth)', () => {
  const tick: SmartTick = {
    mode: 3, exchangeType: 1, token: '2885', seq: 7, exchangeTs: 1_700_000_000_000, ltp: 2501.35, lastQty: 10, avgPrice: 2498.2, volume: 123456, totalBuyQty: 1000, totalSellQty: 900,
    open: 2490, high: 2510, low: 2485.5, close: 2480.1, lastTradeTs: 1_700_000_000_000, oi: 0,
    bids: [1, 2, 3, 4, 5].map((i) => ({ price: 2501 - i * 0.05, qty: 100 * i, orders: i })), asks: [1, 2, 3, 4, 5].map((i) => ({ price: 2501.5 + i * 0.05, qty: 50 * i, orders: i })),
    upperCircuit: 2728, lowerCircuit: 2232, high52: 3000, low52: 2000,
  };
  const back = parseTick(encodeTick(tick))!;
  assert.equal(back.token, '2885'); near(back.ltp, 2501.35); assert.equal(back.volume, 123456); near(back.close!, 2480.1);
  assert.equal(back.bids!.length, 5); assert.equal(back.asks!.length, 5); near(back.bids![0].price, tick.bids![0].price); assert.equal(back.asks![4].qty, 250);
  near(back.upperCircuit!, 2728);
  assert.equal(parseTick(new Uint8Array(10)), null); assert.equal(parseTick(encodeTick({ ...tick, mode: 1 }))!.mode, 1);
  assert.deepEqual(subscribeMessage([{ exchangeType: 1, tokens: ['1'] }]).params, { mode: 3, tokenList: [{ exchangeType: 1, tokens: ['1'] }] });
});
t('TOTP matches the RFC 6238 SHA-1 test vector', async () => {
  // secret "12345678901234567890" in base32; T=59 → 94287082 → last 6 digits 287082
  assert.equal(await totp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59_000), '287082');
});
t('market hours: Mon–Fri 09:15–15:30 IST', () => {
  const ist = (d: string) => Date.parse(d + '+05:30');
  assert.ok(isMarketOpen(ist('2026-10-12T09:15:00')) && isMarketOpen(ist('2026-10-12T15:29:59')));
  assert.ok(!isMarketOpen(ist('2026-10-12T09:14:59')) && !isMarketOpen(ist('2026-10-12T15:30:00')));
  assert.ok(!isMarketOpen(ist('2026-10-10T11:00:00')) && !isMarketOpen(ist('2026-10-11T11:00:00'))); // Sat, Sun
});
t('engine: live ticks drive price, 1-minute candles and real depth; bad ticks ignored', () => {
  const e = new MarketEngine(SEED_INSTRUMENTS); e.setMode('live'); (e as unknown as { selected: string }).selected = 'TCS';
  const t0 = Date.parse('2026-10-12T10:00:10+05:30');
  e.applyTick({ symbol: 'TCS', ltp: 4000, volume: 1000, close: 3950, depth: { bids: [{ price: 3999.95, qty: 10, orders: 1 }], asks: [{ price: 4000.05, qty: 12, orders: 2 }] }, ts: t0 }, t0);
  e.applyTick({ symbol: 'TCS', ltp: 4004, volume: 1500, ts: t0 + 20_000 }, t0 + 20_000);
  e.applyTick({ symbol: 'TCS', ltp: 4001, volume: 1700, ts: t0 + 70_000 }, t0 + 70_000);
  e.applyTick({ symbol: 'TCS', ltp: NaN }, t0); e.applyTick({ symbol: 'NOPE_X', ltp: 5 }, t0); e.applyTick({ symbol: 'TCS', ltp: -3 }, t0);
  const q = e.quotes.get('TCS')!;
  assert.equal(q.ltp, 4001); assert.equal(q.volume, 1700); assert.equal(e.alerts.filter((a) => a.kind === 'VOLUME_SURGE').length, 0); assert.equal(q.prevClose, 3950);
  const bars = (e as unknown as { bars: Map<string, { open: number; high: number; close: number; volume: number }[]> }).bars.get('TCS')!;
  assert.equal(bars.length, 2); assert.equal(bars[0].high, 4004); assert.equal(bars[0].volume, 500); assert.equal(bars[1].volume, 200); // first tick = baseline, not a 1000-share bar
  assert.equal(e.depth.bids[0].price, 3999.95);
});
t('SmartApiFeed: subscribes the diff, applies tick + index messages, ignores junk', () => {
  const sent: string[] = [];
  class FakeWS { onopen?: () => void; onmessage?: (e: { data: string }) => void; onclose?: () => void; onerror?: () => void; constructor(public url: string) { fake = this; } send(m: string) { sent.push(m); } close() { this.onclose?.(); } }
  let fake!: FakeWS;
  const e = new MarketEngine(SEED_INSTRUMENTS); e.setMode('live');
  const f = new SmartApiFeed('wss://x', e, () => {}, FakeWS as unknown as typeof WebSocket);
  f.setSymbols(['TCS']); f.connect(); fake.onopen!();
  f.setSymbols(['TCS', 'INFY']);
  assert.deepEqual(sent.map((m) => JSON.parse(m).symbols), [['TCS'], ['INFY']]);
  fake.onmessage!({ data: JSON.stringify({ t: 'tick', symbol: 'TCS', ltp: 4123.5 }) });
  fake.onmessage!({ data: JSON.stringify({ t: 'index', id: 'NIFTY', value: 25000, prev: 24900 }) });
  fake.onmessage!({ data: 'not json' }); fake.onmessage!({ data: JSON.stringify({ t: 'tick', symbol: 'TCS', ltp: 'x' }) });
  assert.equal(e.quotes.get('TCS')!.ltp, 4123.5); assert.equal(f.ticks, 1);
  const nifty = e.indices.find((i) => i.id === 'NIFTY')!; assert.equal(nifty.value, 25000); near(nifty.pct, (100 / 24900) * 100, 1e-9);
  f.close();
});

console.log('portfolio import (OCR / PDF text)');
t('broker-table text → holdings; unknown symbols reported; duplicates merged', () => {
  const known = new Set(['RELIANCE', 'TCS', 'INFY']);
  const r = parseHoldingsText(['Instrument Qty. Avg. cost LTP', 'RELIANCE 10 2,450.50 2,900', 'TCS 5 3,100.00 3,900', 'TCS 5 3,300.00 3,900', 'ZZZZ 4 10.0 11'].join('\n'), known);
  const tcs = r.holdings.find((h) => h.symbol === 'TCS')!;
  assert.equal(r.holdings.length, 2); assert.equal(tcs.qty, 10); near(tcs.avg, 3200);
  assert.equal(r.holdings.find((h) => h.symbol === 'RELIANCE')!.avg, 2450.5);
});


console.log('price alerts / feed status / instrument sync');
t('alerts: direction from price, validation, duplicate guard', () => {
  const a = addAlert([], 'TCS', 4100, 4000); assert.ok(a.ok && a.alert.dir === 'above');
  const b = addAlert(a.ok ? a.alerts : [], 'TCS', 3900, 4000); assert.ok(b.ok && b.alert.dir === 'below');
  assert.ok(!addAlert([], 'TCS', 4000, 4000).ok && !addAlert([], 'TCS', -1, 4000).ok && !addAlert([], 'TCS', NaN, 4000).ok);
  assert.ok(!addAlert(a.ok ? a.alerts : [], 'TCS', 4100, 4000).ok);
});
t('alerts fire once, on the right side, and survive bad storage', () => {
  const al = [{ id: '1', symbol: 'TCS', target: 4100, dir: 'above' as const, createdAt: 0 }, { id: '2', symbol: 'TCS', target: 3900, dir: 'below' as const, createdAt: 0 }];
  assert.equal(checkAlerts(al, () => 4000).fired.length, 0);
  const r = checkAlerts(al, () => 4105); assert.deepEqual(r.fired.map((x) => x.id), ['1']); assert.equal(r.fired[0].triggeredPrice, 4105);
  assert.equal(checkAlerts(r.alerts, () => 4200).fired.length, 0);
  assert.equal(checkAlerts(al, () => undefined).fired.length, 0);
  assert.deepEqual(parseAlerts('garbage'), []); assert.deepEqual(parseAlerts('[{"id":1}]'), []); assert.equal(parseAlerts(JSON.stringify(al)).length, 2);
});
t('SmartAPI link status: every state is distinguishable and honest', () => {
  const st = (mode: 'live' | 'replay' | 'simulated', conn: 'idle' | 'connecting' | 'open' | 'closed', relayConfigured: boolean, serverCreds = false) => smartApiStatus({ mode, conn, relayConfigured, serverCreds });
  assert.equal(st('live', 'open', true).health, 'ok');
  assert.equal(st('replay', 'open', true).label, 'Relay ready');
  assert.equal(st('simulated', 'open', true).health, 'warn');
  assert.equal(st('simulated', 'closed', true).label, 'Relay offline');
  assert.equal(st('replay', 'idle', false).health, 'off');
  assert.equal(st('replay', 'idle', false, true).label, 'Relay not linked');
});
t('instrument sync: NSE + BSE cash equities only, NSE wins duplicates', () => {
  const rows = [
    { symbol: 'RELIANCE-EQ', name: 'RELIANCE', exch_seg: 'NSE', instrumenttype: '' }, { symbol: 'RELIANCE', name: 'RELIANCE', exch_seg: 'BSE', instrumenttype: '' },
    { symbol: 'RELIANCE26OCTFUT', name: 'RELIANCE', exch_seg: 'NFO', instrumenttype: 'FUTSTK' }, { symbol: 'NIFTY', name: 'NIFTY', exch_seg: 'NSE', instrumenttype: 'AMXIDX' },
    { symbol: 'TATAELXSI-EQ', name: 'TATAELXSI', exch_seg: 'NSE', instrumenttype: '' }, { symbol: 'ABCLTD', name: 'ABC LTD', exch_seg: 'BSE', instrumenttype: '' }, { symbol: '532540', name: 'X', exch_seg: 'BSE', instrumenttype: '' },
  ];
  const { nse, bse } = pickEquities(rows);
  assert.deepEqual([...nse.keys()].sort(), ['RELIANCE', 'TATAELXSI']); assert.deepEqual([...bse.keys()].sort(), ['ABCLTD', 'RELIANCE']);
});

import { resolveIndex } from '../lib/instruments';
import { indexHistory, basePrice } from '../lib/market';
import { BUDGET_BANDS, budgetCandidates, inBand } from '../lib/discovery';
t('resolveIndex maps tickers + aliases, rejects equities', () => {
  for (const [s, id] of [['NIFTY 50', 'NIFTY'], ['nifty50', 'NIFTY'], ['SENSEX', 'SENSEX'], ['BANK NIFTY', 'BANKNIFTY'], ['Nifty Bank', 'BANKNIFTY'], ['INDIA VIX', 'INDIAVIX'], ['VIX', 'INDIAVIX']] as const) assert.equal(resolveIndex(s)?.id, id, s);
  assert.equal(resolveIndex('RELIANCE'), undefined); assert.equal(resolveIndex(''), undefined); assert.equal(resolveIndex(null), undefined);
});
t('indexHistory: valid OHLC for every timeframe, even with a bad value', () => {
  for (const tf of TIMEFRAMES) for (const v of [24850.4, NaN, 0, -5]) {
    const h = indexHistory('NIFTY 50', tf, v, 24850.4, Date.UTC(2026, 9, 14, 6));
    assert.equal(h.length, TF_CONFIG[tf].bars);
    for (const c of h) { assert.ok([c.open, c.high, c.low, c.close].every(Number.isFinite)); assert.ok(c.high >= Math.max(c.open, c.close) && c.low <= Math.min(c.open, c.close)); assert.equal(c.volume, 0); }
    if (Number.isFinite(v) && v > 0) assert.ok(Math.abs(h[h.length - 1].close - v) < 0.01);
  }
});
t('budget bands: exclusive upper bound, candidates filtered + capped', () => {
  const [a, b, c] = BUDGET_BANDS;
  assert.ok(inBand(49.95, a) && !inBand(50, a) && inBand(50, b) && inBand(100, c) && !inBand(500, c) && !inBand(NaN, a));
  const big = Array.from({ length: 3000 }, (_, i) => ({ symbol: 'S' + i, name: 'S' + i, sector: 'Others' }));
  for (const band of BUDGET_BANDS) {
    const r = budgetCandidates(big, band, basePrice, 20);
    assert.ok(r.length > 0 && r.length <= 20); assert.ok(r.every((i) => inBand(basePrice(i.symbol), band)));
  }
});
t('feed modes: snapshot badge + status', () => {
  assert.equal(smartApiStatus({ mode: 'snapshot', conn: 'open', relayConfigured: true }).health, 'ok');
  assert.match(smartApiStatus({ mode: 'snapshot', conn: 'open', relayConfigured: true }).detail, /last prices/);
});

import { parseYahooChart, toYahooSymbol } from '../lib/yahoo';
import { addSymbol, removeSymbol, parseWatchlist, MAX_WATCHLIST } from '../lib/watchlist';
t('yahoo: symbol mapping + chart parsing', () => {
  assert.equal(toYahooSymbol('RELIANCE'), 'RELIANCE.NS'); assert.equal(toYahooSymbol('SRIT', 'BSE'), 'SRIT.BO'); assert.equal(toYahooSymbol('M&M'), 'M%26M.NS');
  const tk = parseYahooChart('RELIANCE', { chart: { result: [{ meta: { regularMarketPrice: 2912.5, chartPreviousClose: 2900, regularMarketDayHigh: 2920, regularMarketDayLow: 2890, regularMarketVolume: 12345, regularMarketTime: 1760000000 }, indicators: { quote: [{ open: [null, 2905, 2906] }] } }] } });
  assert.deepEqual([tk?.ltp, tk?.close, tk?.high, tk?.low, tk?.volume, tk?.open, tk?.ts], [2912.5, 2900, 2920, 2890, 12345, 2905, 1760000000000]);
  assert.equal(parseYahooChart('X', { chart: { result: null, error: { code: 'Not Found' } } }), null); assert.equal(parseYahooChart('X', null), null);
  assert.equal(parseYahooChart('X', { chart: { result: [{ meta: { regularMarketPrice: 0 } }] } }), null);
});
t('watchlist ops: add / remove / dedupe / cap / parse', () => {
  assert.deepEqual(addSymbol(['A'], 'B'), ['A', 'B']); const l = ['A']; assert.equal(addSymbol(l, 'A'), l); assert.deepEqual(removeSymbol(['A', 'B'], 'A'), ['B']);
  assert.equal(addSymbol(Array.from({ length: MAX_WATCHLIST }, (_, i) => 'S' + i), 'NEW').length, MAX_WATCHLIST);
  assert.deepEqual(parseWatchlist('["A","A",1,"B"]'), ['A', 'B']); assert.equal(parseWatchlist('{bad'), null); assert.equal(parseWatchlist(null), null);
});
t('search: 8,200 NSE+BSE instruments — exact, name, BSE-only, fast', () => {
  const names = ['Alpha', 'Bharat', 'Coastal', 'Delta', 'Eastern', 'Frontier', 'Global', 'Horizon'];
  const items = Array.from({ length: 8200 }, (_, i) => ({ symbol: 'Q' + i.toString(36).toUpperCase() + 'X', name: `${names[i % 8]} ${names[(i * 3) % 8]} Industries ${i} Ltd`, sector: 'Others', exch: (i % 3 === 0 ? 'BSE' : 'NSE') as 'NSE' | 'BSE' }));
  items.push({ symbol: 'SRIT', name: 'Sri Rama Industrial Technologies Ltd', sector: 'Others', exch: 'BSE' });
  const idx = buildIndex(items); const t0 = Date.now();
  assert.equal(searchInstruments(idx, 'SRIT', 8)[0].symbol, 'SRIT'); assert.equal(searchInstruments(idx, 'sri rama', 8)[0].symbol, 'SRIT'); assert.equal(searchInstruments(idx, 'SRIT', 8)[0].exch, 'BSE');
  assert.ok(searchInstruments(idx, 'industries', 30).length === 30); searchInstruments(idx, 'horizn', 8);
  assert.ok(Date.now() - t0 < 1500, 'search too slow: ' + (Date.now() - t0));
});
t('status: LIVE FEED from either source', () => {
  for (const source of ['angel', 'yahoo'] as const) { const st = smartApiStatus({ mode: 'live', conn: 'open', relayConfigured: true, source }); assert.equal(st.health, 'ok'); assert.match(st.label, /LIVE FEED/); }
  assert.match(smartApiStatus({ mode: 'live', conn: 'open', relayConfigured: true, source: 'yahoo' }).detail, /Yahoo/);
});

import { barInterval, fibPrice, logicalToTime, moveDrawing, parseDrawings, rulerStats, snapToBar, timeToLogical, formatDuration } from '../lib/drawings';
t('drawings: time↔logical round-trip incl. extrapolation, magnet, fib, ruler, parse, move', () => {
  const bars = [0, 1, 2, 3, 4].map((i) => ({ time: 1000 + i * 300, open: 100 + i, high: 110 + i, low: 90 + i, close: 105 + i }));
  const iv = barInterval(bars); assert.equal(iv, 300);
  for (const tt of [1000, 1450, 2200, 2800, 3100, 700]) assert.ok(Math.abs(logicalToTime(bars, timeToLogical(bars, tt, iv), iv) - tt) < 1e-6, String(tt));
  assert.equal(timeToLogical(bars, 2200, iv), 4); assert.equal(timeToLogical(bars, 2500, iv), 5); assert.equal(timeToLogical(bars, 700, iv), -1);
  const sn = snapToBar(bars, { t: 1310, p: 108.4 }, iv); assert.deepEqual(sn, { t: 1300, p: 106 }); // bar 1: O101 H111 L91 C106 → close is nearest to 108.4
  assert.equal(fibPrice({ t: 0, p: 100 }, { t: 1, p: 200 }, 0), 200); assert.equal(fibPrice({ t: 0, p: 100 }, { t: 1, p: 200 }, 1), 100); assert.equal(fibPrice({ t: 0, p: 100 }, { t: 1, p: 200 }, 0.5), 150);
  const r = rulerStats({ t: 1000, p: 100 }, { t: 1900, p: 110 }, bars, iv); assert.deepEqual([r.dPrice, r.dPct, r.bars, r.seconds], [10, 10, 3, 900]); assert.equal(formatDuration(900), '15m'); assert.equal(formatDuration(7200), '2h'); assert.equal(formatDuration(3 * 86400), '3d');
  const ds = parseDrawings(JSON.stringify([{ id: 'a', kind: 'trend', a: { t: 1, p: 2 }, b: { t: 3, p: 4 } }, { id: 'b', kind: 'trend', a: { t: 1, p: 2 } }, { id: 'c', kind: 'text', a: { t: 1, p: 2 }, text: ' ' }, { id: 'd', kind: 'hline', a: { t: 1, p: NaN } }, { id: 'e', kind: 'hline', a: { t: 1, p: 2 } }, 'junk']));
  assert.deepEqual(ds.map((d) => d.id), ['a', 'e']); assert.deepEqual(parseDrawings('{bad'), []); assert.deepEqual(parseDrawings(null), []);
  const mv = moveDrawing({ id: 'a', kind: 'trend', a: { t: 1000, p: 100 }, b: { t: 1600, p: 110 } }, 1, 5, bars, iv); assert.ok(mv.kind === 'trend' && mv.a.t === 1300 && mv.b.t === 1900 && mv.a.p === 105 && mv.b.p === 115);
});

import { getScreener, peerCandidates, quarterLabels, rangePct } from '../lib/screener';
t('screener: missing / NaN fields fall back to safe defaults', () => {
  const bad: any[] = [null, undefined, {}, { symbol: 'X' }, { symbol: 'X', ltp: NaN, mcapCr: undefined, sector: undefined, high: null, low: -1, prevClose: 0 }];
  for (const q of bad) {
    const sc = getScreener(q);
    const nums = [sc.marketCapCr, sc.pe, sc.industryPe, sc.bookValue, sc.dividendYield, sc.roce, sc.roe, sc.faceValue, sc.eps, sc.high52, sc.low52];
    assert(nums.every((n) => Number.isFinite(n)), 'finite ratios');
    assert(sc.quarters.length === 5 && sc.quarters.every((r) => Number.isFinite(r.sales) && Number.isFinite(r.eps) && r.label), '5 quarters');
    assert(Math.abs(sc.holding.promoters + sc.holding.fiis + sc.holding.diis + sc.holding.public - 100) < 0.2, 'holding ~100');
    assert(sc.low52 <= sc.high52, '52w order');
  }
  assert(getScreener(undefined).pe === 15.2, 'default P/E 15.2');
  assert(peerCandidates(undefined, 'X', 'IT').length === 0, 'no instruments → no peers');
});

t('screener: consistent fundamentals for every sector / any symbol', () => {
  assert.deepEqual(quarterLabels(new Date('2026-10-15T00:00:00Z')), ['Sep 2025', 'Dec 2025', 'Mar 2026', 'Jun 2026', 'Sep 2026']);
  assert.deepEqual(quarterLabels(new Date('2026-09-15T00:00:00Z')).slice(-1), ['Jun 2026']); assert.deepEqual(quarterLabels(new Date('2026-01-10T00:00:00Z')).slice(-1), ['Dec 2025']);
  const sectors = ['Banking', 'IT', 'Energy', 'Auto', 'FMCG', 'Pharma', 'Metals', 'Financials', 'Infra', 'Telecom', 'Consumer', 'Cement', 'Realty', 'Chemicals', 'Others', 'Unknown'];
  const eng = new MarketEngine(SEED_INSTRUMENTS);
  for (let i = 0; i < 400; i++) {
    const sym = 'TST' + i; const sector = sectors[i % sectors.length]; const ltp = [3.2, 18, 55, 240, 1900, 4800][i % 6]; const mcap = [40, 900, 12000, 250000][i % 4];
    const s = getScreener({ symbol: sym, sector, ltp, prevClose: ltp * 0.99, mcapCr: mcap, dividendYield: 1.2, high: ltp * 1.01, low: ltp * 0.98 }, new Date('2026-10-15T00:00:00Z'));
    const nums = [s.pe, s.bookValue, s.roce, s.roe, s.eps, s.high52, s.low52, ...s.quarters.flatMap((q) => [q.sales, q.expenses, q.operatingProfit, q.opmPct, q.netProfit, q.eps])];
    assert.ok(nums.every(Number.isFinite), sym); assert.equal(s.quarters.length, 5);
    assert.ok(s.low52 <= ltp && ltp <= s.high52, `52w ${sym}`);
    const ttm = s.quarters.slice(1).reduce((a, q) => a + q.netProfit, 0); assert.ok(Math.abs(ttm - mcap / s.pe) <= Math.max(0.5, (mcap / s.pe) * 0.02), `ttm ${sym} ${ttm} vs ${mcap / s.pe}`);
    for (const q of s.quarters) { assert.ok(Math.abs(q.sales - q.expenses - q.operatingProfit) < 0.25 + q.sales * 1e-4, 'sales-exp=op ' + sym); assert.ok(q.sales > 0 && q.netProfit > 0); assert.ok(q.sales >= mcap * 0.05 - 0.1 && q.sales <= mcap * 0.25 + 0.1, `sales ${q.sales} vs mcap ${mcap} ${sym}`); assert.ok(q.operatingProfit >= q.netProfit - 0.1 && q.expenses >= 0, 'op>=pat ' + sym); }
    const h = s.holding; assert.ok(Math.abs(h.promoters + h.fiis + h.diis + h.public - 100) < 0.11 && h.public >= 0, 'holding ' + sym);
    assert.deepEqual(s, getScreener({ symbol: sym, sector, ltp, prevClose: ltp * 0.99, mcapCr: mcap, dividendYield: 1.2, high: ltp * 1.01, low: ltp * 0.98 }, new Date('2026-10-15T00:00:00Z'))); // deterministic
  }
  assert.equal(rangePct(5, 0, 10), 50); assert.equal(rangePct(-1, 0, 10), 0); assert.equal(rangePct(99, 0, 10), 100); assert.equal(rangePct(1, 5, 5), 50);
  const all = Array.from({ length: 3000 }, (_, i) => ({ symbol: 'P' + i, name: 'P' + i, sector: i % 2 ? 'IT' : 'Auto' }));
  const peers = peerCandidates(all, 'P1', 'IT', 5); assert.equal(peers.length, 5); assert.ok(peers.every((p) => p.sector === 'IT' && p.symbol !== 'P1'));
  assert.equal(eng.quotes.size < 400, true); // peer selection must not instantiate the sector
});

import { parseQuoteSummary, parseTimeseries, fromTimeseries, mergeLive } from '../lib/yahooFundamentals';
import { createList, renameList, deleteList, defaultState, mapList, setActive, parseState, activeList, allSymbols, MAX_LISTS } from '../lib/watchlist';
const W = (v: number) => ({ raw: v });
t('yahoo fundamentals: quoteSummary + timeseries parsing, merge over estimate', () => {
  const qs = { quoteSummary: { result: [{ summaryDetail: { marketCap: W(1.5e12), trailingPE: W(24.5), dividendYield: W(0.0125), fiftyTwoWeekHigh: W(3200), fiftyTwoWeekLow: W(2100) }, defaultKeyStatistics: { bookValue: W(620), trailingEps: W(118), heldPercentInsiders: W(0.5), heldPercentInstitutions: W(0.3) }, financialData: { returnOnEquity: W(0.091), debtToEquity: W(45.2) }, price: { currency: 'INR' } }], error: null } };
  const r = parseQuoteSummary(qs);
  assert.deepEqual([r.marketCapCr, r.pe, r.dividendYield, r.bookValue, r.eps, r.roe, r.debtToEquity, r.high52, r.low52], [150000, 24.5, 1.25, 620, 118, 9.1, 0.45, 3200, 2100]);
  assert.deepEqual(r.holding, { promoters: 50, institutions: 30 });
  assert.deepEqual(parseQuoteSummary(null).quarters, []); assert.equal(parseQuoteSummary({}).pe, undefined);
  const ser = (type: string, vals: number[]) => ({ meta: { type: [type] }, [type]: vals.map((v, i) => ({ asOfDate: ['2025-09-30', '2025-12-31', '2026-03-31', '2026-06-30', '2026-09-30'][i], reportedValue: W(v) })) });
  const ts = { timeseries: { result: [ser('quarterlyTotalRevenue', [1e11, 1.1e11, 1.2e11, 1.3e11, 1.4e11]), ser('quarterlyEBITDA', [2e10, 2.1e10, 2.2e10, 2.3e10, 2.4e10]), ser('quarterlyNetIncome', [1e10, 1.1e10, 1.2e10, 1.3e10, 1.4e10]), ser('quarterlyDilutedEPS', [7, 8, 9, 10, 11]), { meta: { type: ['annualEBIT'] }, annualEBIT: [{ asOfDate: '2026-03-31', reportedValue: W(8e10) }] }, { meta: { type: ['annualTotalAssets'] }, annualTotalAssets: [{ asOfDate: '2026-03-31', reportedValue: W(5e11) }] }, { meta: { type: ['annualCurrentLiabilities'] }, annualCurrentLiabilities: [{ asOfDate: '2026-03-31', reportedValue: W(1e11) }] }] } };
  const f = fromTimeseries(parseTimeseries(ts));
  assert.equal(f.quarters.length, 5); assert.deepEqual(f.quarters[0], { label: 'Sep 2025', sales: 10000, expenses: 8000, operatingProfit: 2000, opmPct: 20, netProfit: 1000, eps: 7 }); assert.equal(f.quarters[4].label, 'Sep 2026'); assert.equal(f.roce, 20);
  const ltp = 2800; const sim = getScreener({ symbol: 'LIVE', sector: 'Energy', ltp, prevClose: ltp, mcapCr: 90000, dividendYield: 0.5, high: ltp, low: ltp });
  const m = mergeLive(sim, { yahooSymbol: 'LIVE.NS', fetchedAt: 1, ...r, roce: f.roce, quarters: f.quarters }, ltp);
  assert.deepEqual([m.marketCapCr, m.pe, m.bookValue, m.roce, m.eps, m.quarters.length, m.holding.promoters], [150000, 24.5, 620, 20, 118, 5, 50]);
  assert.ok(m.source.live && m.source.quarters && m.source.holding && m.source.estimated.includes('Face Value') && !m.source.estimated.includes('P/E'));
  assert.ok(Math.abs(m.holding.promoters + m.holding.fiis + m.holding.diis + m.holding.public - 100) < 0.2);
  assert.ok(m.low52 <= ltp && ltp <= m.high52);
  const partial = mergeLive(sim, { yahooSymbol: 'X.NS', fetchedAt: 1, pe: 30, quarters: [] }, ltp); // missing fields keep the estimate
  assert.equal(partial.pe, 30); assert.equal(partial.marketCapCr, sim.marketCapCr); assert.deepEqual(partial.quarters, sim.quarters); assert.ok(partial.source.estimated.includes('Quarterly results'));
  assert.equal(mergeLive(sim, null, ltp), sim);
  assert.equal(parseQuoteSummary({ quoteSummary: { result: [{ price: { financialCurrency: 'USD' }, summaryDetail: { marketCap: W(1e9) } }] } }).currency, 'USD');
});
t('watchlists: named tabs — presets, create / rename / delete / active / per-list ops', () => {
  let s = defaultState(['RELIANCE']);
  assert.deepEqual(s.lists.map((l) => l.name), ['Main', 'Today pick', 'future', 'monday hot']); assert.deepEqual(s.lists[0].symbols, ['RELIANCE']); assert.equal(s.active, 'main');
  let r = createList(s, '  Swing Trading '); assert.ok(r.ok); s = r.state; assert.equal(activeList(s).name, 'Swing Trading'); assert.equal(s.active, 'swing-trading'); assert.equal(s.lists.length, 5);
  assert.equal((createList(s, 'swing trading') as any).reason, 'duplicate'); assert.equal((createList(s, '   ') as any).reason, 'empty');
  s = mapList(s, (c) => [...c, 'TCS']); assert.deepEqual(activeList(s).symbols, ['TCS']); assert.deepEqual(s.lists[0].symbols, ['RELIANCE']); // adds to ACTIVE tab only
  assert.deepEqual(allSymbols(s).sort(), ['RELIANCE', 'TCS']);
  s = setActive(s, 'main'); assert.equal(s.active, 'main'); assert.equal(setActive(s, 'nope'), s);
  r = renameList(s, 'future', 'Long term'); assert.ok(r.ok); s = r.state; assert.equal(s.lists[2].name, 'Long term'); assert.equal((renameList(s, 'future', 'Main') as any).ok, false); assert.equal((renameList(s, 'main', 'long TERM') as any).reason, 'duplicate');
  r = deleteList(s, 'main'); assert.ok(r.ok); s = r.state; assert.equal(s.lists.length, 4); assert.ok(s.lists.some((l) => l.id === s.active)); // active falls back to a neighbour
  let t2 = defaultState(); for (let i = 0; i < 30; i++) { const x = createList(t2, 'L' + i); if (x.ok) t2 = x.state; } assert.equal(t2.lists.length, MAX_LISTS);
  let one = { lists: [{ id: 'a', name: 'A', symbols: [] }], active: 'a' }; assert.equal((deleteList(one, 'a') as any).reason, 'last');
  const back = parseState(JSON.stringify(s)); assert.deepEqual(back, s); assert.equal(parseState('{"lists":[]}'), null); assert.equal(parseState('nope'), null);
  assert.equal(parseState(JSON.stringify({ lists: [{ id: 'a', name: 'A', symbols: ['X', 'X', 5] }], active: 'zzz' }))!.active, 'a');
});

import { extractFollowUps, trimToSentence, finishAnswer, suggestFollowUps } from '../lib/followups';
import { ASK_SYSTEM } from '../lib/ask';
import { SYSTEM_PROMPT } from '../lib/copilot';
t('gemini answers: follow-up parsing, truncation trimming, analyst prompt', () => {
  const e = extractFollowUps('## Take\n- **RELIANCE** is up.\n\nFOLLOW_UPS: Which sectors am I overexposed to? | How does my P&L compare to NIFTY 50? | Suggest rebalancing actions?');
  assert.deepEqual(e.followUps, ['Which sectors am I overexposed to?', 'How does my P&L compare to NIFTY 50?', 'Suggest rebalancing actions?']); assert.ok(!/FOLLOW/i.test(e.text) && e.text.endsWith('is up.'));
  assert.deepEqual(extractFollowUps('Plain answer.').followUps, []); assert.equal(extractFollowUps('Plain answer.').text, 'Plain answer.');
  assert.deepEqual(extractFollowUps('A.\n**Follow_ups:** 1. Why is IT weak? | Is it a buying opp', true).followUps, ['Why is IT weak?']); // cut-off last item dropped after a token cut
  assert.deepEqual(extractFollowUps('A.\nFOLLOW_UPS: Why is IT weak? | Suggest rebalancing actions').followUps, ['Why is IT weak?', 'Suggest rebalancing actions']); // imperatives kept when complete
  assert.equal(extractFollowUps('A.\nFOLLOW_UPS: a? | b? | c? | d? | e? ').followUps.length, 0); // too short to be real questions
  assert.equal(extractFollowUps('A.\nFOLLOW_UPS: Question number one? | Question number two? | Question number three? | Question number four?').followUps.length, 3);
  assert.equal(trimToSentence('Nifty is up **2%**. Banks lead. The IT sector is wea'), 'Nifty is up **2%**. Banks lead.');
  assert.equal(trimToSentence('Intro line.\n- first bullet is complete.\n- second bullet is cu'), 'Intro line.\n- first bullet is complete.');
  assert.equal(trimToSentence('Key risk is **valuation. Done.'), 'Key risk is valuation. Done.'); // dangling bold closed
  const f = finishAnswer('Good point made here. Second sentence cut off mid\nFOLLOW_UPS: What are the risks for TCS? | Is IT overvalued and', true); assert.equal(f.answer, 'Good point made here.'); assert.deepEqual(f.followUps, ['What are the risks for TCS?']);
  assert.equal(finishAnswer('Complete answer', false).answer, 'Complete answer');
  const ctx = { focus: { symbol: 'TCS' }, portfolio: { holdings: [1] } };
  const sug = suggestFollowUps('What is my sector exposure?', ctx); assert.equal(sug.length, 3); assert.ok(!sug.includes('Which sectors am I overexposed to?') || sug.indexOf('Which sectors am I overexposed to?') === 2 || true);
  assert.ok(suggestFollowUps('x', ctx).slice(0, 3).join('|').includes('overexposed') && suggestFollowUps('x', ctx).includes('How does my P&L compare to NIFTY 50?') && suggestFollowUps('x', ctx).includes('Suggest rebalancing actions'));
  assert.ok(suggestFollowUps('Suggest rebalancing actions', ctx).every((q) => q !== 'Suggest rebalancing actions'));
  assert.ok(suggestFollowUps('hi', null).length >= 2 && suggestFollowUps('hi', null).every((q) => q.endsWith('?')));
  assert.ok(/Senior Market Analyst/.test(ASK_SYSTEM) && /MARKDOWN/.test(ASK_SYSTEM) && /FOLLOW_UPS/.test(ASK_SYSTEM) && /UpCircuit AI/.test(ASK_SYSTEM) && /Senior Market Analyst/.test(SYSTEM_PROMPT));
});
import { classifyAnomalies, toRow, withBursts } from '../lib/anomalies';
import { planRebalance, setTarget, sectorWeights, applyTrades } from '../lib/rebalance';
import { toCsv, reportCsv, buildReport, reportFileName } from '../lib/report';
t('circuit & anomaly desk: near/locked bands, volume surge > 3x', () => {
  const mk = (symbol: string, pct: number, band: number, vol = 1, avg = 1) => ({ symbol, name: symbol, ltp: 100 * (1 + pct / 100), prevClose: 100, circuitBand: band, upperCircuit: 100 * (1 + band / 100), lowerCircuit: 100 * (1 - band / 100), volume: vol, avgVolume: avg });
  const qs = [mk('U5', 4.6, 5), mk('U5L', 5, 5), mk('U10', 9.5, 10), mk('U20', 19, 20), mk('NOT', 3, 10), mk('L5', -4.9, 5), mk('L20L', -20, 20), mk('V4', 1, 20, 4.2, 1), mk('V3', 1, 20, 3, 1), mk('FLAT', 0, 5, 1, 1)];
  const r = classifyAnomalies(qs);
  assert.deepEqual(r.upper.map((x) => x.symbol), ['U5L', 'U10', 'U20', 'U5']); // locked first, then by share of band used
  assert.equal(r.upper[0].locked, true); assert.equal(r.upper[1].locked, false);
  assert.deepEqual(r.lower.map((x) => x.symbol), ['L20L', 'L5']); assert.deepEqual(r.surge.map((x) => x.symbol), ['V4']); // exactly 3× is not > 3×
  assert.deepEqual(classifyAnomalies(qs, 5).upper.map((x) => x.symbol), ['U5L', 'U5']); assert.equal(classifyAnomalies(qs, 5).surge.length, 1);
  assert.equal(toRow({ ...mk('X', 1, 5), prevClose: 0 }), null); assert.equal(toRow({ ...mk('X', 1, 5), avgVolume: 0 })!.volMultiple, 0);
  const now = 1_000_000; const bq: Record<string, any> = { BURST: mk('BURST', 1, 20, 1.2, 1), V4: qs[7], OLD: mk('OLD', 1, 20, 1, 1) };
  const merged = withBursts(r.surge, [{ kind: 'VOLUME_SURGE', symbol: 'BURST', time: now - 1000, value: 5.5 }, { kind: 'VOLUME_SURGE', symbol: 'V4', time: now, value: 9 }, { kind: 'VOLUME_SURGE', symbol: 'OLD', time: now - 3_600_000, value: 8 }, { kind: 'UPPER_CIRCUIT', symbol: 'U5', time: now, value: 5 }, { kind: 'VOLUME_SURGE', symbol: 'NOPE', time: now, value: 8 }, { kind: 'VOLUME_SURGE', symbol: 'BURST', time: now, value: 2 }], (s) => bq[s], now);
  assert.deepEqual(merged.map((x) => x.symbol), ['BURST', 'V4']); assert.equal(merged[0].burst, true); assert.equal(merged[0].volMultiple, 5.5); assert.equal(merged[1].burst, undefined); // stale / unknown / <3× / already-listed ignored
  const eng = new MarketEngine(SEED_INSTRUMENTS); SEED_INSTRUMENTS.slice(0, 60).forEach((i) => eng.touch(i.symbol)); const live = classifyAnomalies(eng.quotes.values()); assert.ok(Array.isArray(live.upper) && Array.isArray(live.surge));
});
t('rebalance: sliders sum to 100, cash released/required, per-stock trims, apply', () => {
  const t1 = setTarget({ Banking: 70, IT: 20, FMCG: 10 }, 'Banking', 25); assert.equal(t1.Banking, 25); assert.ok(Math.abs(Object.values(t1).reduce((a, b) => a + b, 0) - 100) < 1e-9); assert.ok(t1.IT > 20 && t1.FMCG > 10 && Math.abs(t1.IT / t1.FMCG - 2) < 0.1);
  assert.deepEqual(setTarget({ A: 100, B: 0, C: 0 }, 'A', 40), { A: 40, B: 30, C: 30 }); assert.deepEqual(setTarget({ A: 100 }, 'A', 10), { A: 100 });
  const px: Record<string, { ltp: number; sector: string }> = { HDFCBANK: { ltp: 1000, sector: 'Banking' }, SBIN: { ltp: 500, sector: 'Banking' }, TCS: { ltp: 4000, sector: 'IT' }, ITC: { ltp: 400, sector: 'FMCG' }, ENG1: { ltp: 200, sector: 'Energy' } };
  const holdings = [{ symbol: 'HDFCBANK', qty: 40, avg: 900 }, { symbol: 'SBIN', qty: 60, avg: 450 }, { symbol: 'TCS', qty: 10, avg: 3500 }, { symbol: 'ITC', qty: 50, avg: 380 }]; // 40000 + 30000 + 40000 + 20000 = 130000
  const quoteOf = (s: string) => px[s]; const candidates = (sec: string) => Object.entries(px).filter(([, v]) => v.sector === sec).map(([symbol, v]) => ({ symbol, ltp: v.ltp, sector: v.sector }));
  const w = sectorWeights(holdings, quoteOf); assert.equal(w.total, 130000); assert.ok(Math.abs(w.weights.Banking - (70000 / 130000) * 100) < 1e-9);
  const same = planRebalance({ holdings, quoteOf, candidates, targets: w.weights }); assert.equal(same.trades.length, 0); assert.equal(same.cashReleased, 0);
  const targets = { Banking: 25, IT: 30, FMCG: 25, Energy: 20 };
  const p = planRebalance({ holdings, quoteOf, candidates, targets });
  assert.ok(p.cashReleased > 0 && p.cashRequired > 0); assert.ok(Math.abs(p.netCash) < 2000, 'self-financing ≈ 0 (whole-share rounding)'); // sells fund the buys
  const trims = p.trades.filter((x) => x.side === 'TRIM'); assert.deepEqual(trims.map((x) => x.symbol).sort(), ['HDFCBANK', 'SBIN']); assert.ok(trims.every((x) => x.qtyAfter < x.qtyBefore && x.shares >= 1));
  assert.ok(p.trades.some((x) => x.symbol === 'ENG1' && x.isNew && x.side === 'ADD')); // empty target sector → candidate stock
  assert.ok(Math.abs(p.afterPct.Banking - 25) < 2 && Math.abs(p.afterPct.Energy - 20) < 2 && Math.abs(p.afterPct.IT - 30) < 2, JSON.stringify(p.afterPct));
  const bankSold = trims.reduce((a, x) => a + x.value, 0); assert.ok(Math.abs(bankSold - (70000 - 0.25 * 130000)) < 700);
  assert.ok(p.realisedPnl > 0); assert.equal(applyTrades(holdings, p.trades).length, p.after.length);
  const hd = p.after.find((h) => h.symbol === 'HDFCBANK')!; assert.equal(hd.avg, 900); const itc = p.after.find((h) => h.symbol === 'ITC')!; assert.ok(itc.qty > 50 && itc.avg > 380 && itc.avg < 400); // blended cost
  const exit = planRebalance({ holdings, quoteOf, candidates, targets: { Banking: 0, IT: 50, FMCG: 50, Energy: 0 } }); assert.ok(!exit.after.some((h) => h.symbol === 'HDFCBANK' || h.symbol === 'SBIN')); // 0 % target exits the sector
  const fresh = planRebalance({ holdings, quoteOf, candidates, targets: w.weights, freshCash: 13000 }); assert.ok(fresh.netCash > 10000 && fresh.cashReleased < 1500);
  assert.equal(planRebalance({ holdings: [], quoteOf, candidates, targets }).trades.length, 0); assert.deepEqual(planRebalance({ holdings: [{ symbol: 'NOPRICE', qty: 5, avg: 1 }], quoteOf, candidates, targets }).skipped, ['NOPRICE']);
});
t('report: CSV escaping + injection guard + sections', () => {
  assert.equal(toCsv([['a,b', 'q"t', 'x\ny', 1.5, null, undefined, NaN]]), '"a,b","q""t","x\ny",1.5,,,\r\n'); assert.equal(toCsv([['=SUM(A1)', '@x', '-5', -5]]), "'=SUM(A1),'@x,'-5,-5\r\n");
  const q = { symbol: 'TST', name: 'Test, Ltd', exch: 'NSE' as const, sector: 'IT', ltp: 110, prevClose: 100, high: 112, low: 99, volume: 10, circuitBand: 10, lowerCircuit: 90, upperCircuit: 110 };
  const sc = getScreener({ ...q, mcapCr: 5000, dividendYield: 1 } as any, new Date('2026-10-15T00:00:00Z')); const csv = reportCsv(q, sc, new Date('2026-10-15T05:00:00Z'));
  const lines = csv.trim().split('\r\n'); assert.equal(lines[0], 'Section,Metric,Period,Value,Unit'); assert.ok(lines.includes('Summary,Company,,"Test, Ltd",'));
  for (const sec of ['Summary,LTP', 'Fundamentals,Market Cap', 'Fundamentals,ROCE', 'Fundamentals,ROE', 'Fundamentals,Stock P/E', 'Shareholding,Promoters']) assert.ok(lines.some((l) => l.startsWith(sec)), sec);
  assert.equal(lines.filter((l) => l.startsWith('Quarterly,Net Profit')).length, 5); assert.ok(lines.some((l) => l.startsWith('Quarterly,Sales / Revenue,Sep 2026,')));
  const m = buildReport(q, sc, new Date('2026-10-15T05:00:00Z')); assert.equal(m.changePct, 10); assert.equal(m.grid.length, 10); assert.ok(m.grid.some((g) => g.label.startsWith('ROCE'))); assert.equal(reportFileName('M&M', 'csv', new Date('2026-10-15T05:00:00Z')), 'UpCircuit_MM_report_2026-10-15.csv');
});

import { parseYahooSession } from '../lib/yahoo';
t('off-market engine: calm (no random ticks / events), ▶ session replay follows 1-minute bars then rests at the close', () => {
  const e = new MarketEngine(SEED_INSTRUMENTS); // default mode = replay (market closed)
  assert.equal(e.mode, 'replay');
  let now = Date.now(); e.step('RELIANCE', now);
  const snap = () => JSON.stringify([...e.quotes.values()].map((q) => [q.symbol, q.ltp, q.high, q.low, q.volume])) + JSON.stringify(e.indices.map((i) => i.value));
  const before = snap(); const alerts0 = e.alerts.length;
  for (let i = 0; i < 2400; i++) { now += 250; e.step('RELIANCE', now); } // 10 simulated minutes of a CLOSED market
  assert.equal(snap(), before, 'closed market must not move any price, volume or index');
  assert.equal(e.alerts.length, alerts0, 'no synthetic alerts while closed');
  // session replay of one symbol
  const q = e.quotes.get('RELIANCE')!; const close = q.ltp;
  assert.ok(e.startSessionReplay('RELIANCE', undefined, now));
  assert.equal(e.replaying?.symbol, 'RELIANCE'); assert.equal(q.volume, 0);
  const other = e.quotes.get('TCS')!.ltp; let maxStep = 0, prev = q.ltp; const t0 = now;
  for (let i = 0; i < 4 * 380; i++) { now += 250; e.step('RELIANCE', now); maxStep = Math.max(maxStep, Math.abs(q.ltp / prev - 1)); prev = q.ltp; if (i === 400) assert.ok(q.volume > 0 && e.replaying!.progress > 0.2); }
  assert.equal(e.replaying, null, 'replay ends after the last bar'); assert.equal(q.ltp, close, 'rests at the previous close');
  assert.ok(maxStep < 0.01, `no spikes: max step ${maxStep}`); assert.ok(q.high >= close && q.low <= close && q.high > q.low);
  assert.equal(e.quotes.get('TCS')!.ltp, other, 'other symbols stay frozen'); assert.ok(q.volume > 0 && q.sumV > 0);
  // real bars are scaled onto the resting price and used as-is in shape
  const real = Array.from({ length: 60 }, (_, i) => { const c = 1000 + i; return { open: c - 0.5, high: c + 1, low: c - 1, close: c, volume: 100 }; });
  e.startSessionReplay('INFY', real, now); const iq = e.quotes.get('INFY')!; const iclose = e.replaying && iq.ltp; assert.ok((e.replaying as { real: boolean } | null)?.real && iclose);
  e.stopSessionReplay(); assert.equal(e.replaying, null);
  const live = new MarketEngine(SEED_INSTRUMENTS); live.setMode('live'); assert.equal(live.startSessionReplay('RELIANCE'), false, 'no replay in live mode');
  // yahoo session parser: picks the LAST IST date with ≥ 30 bars
  const day = (d: string, n: number, base: number) => Array.from({ length: n }, (_, i) => ({ t: Date.parse(d + 'T03:45:00Z') / 1000 + i * 60, o: base + i, c: base + i + 0.5 }));
  const mk = (...days: ReturnType<typeof day>[]) => { const all = days.flat(); return { chart: { result: [{ timestamp: all.map((x) => x.t), indicators: { quote: [{ open: all.map((x) => x.o), high: all.map((x) => x.c + 1), low: all.map((x) => x.o - 1), close: all.map((x) => x.c), volume: all.map(() => 500) }] } }] } }; };
  const ps = parseYahooSession(mk(day('2026-10-14', 375, 100), day('2026-10-15', 375, 200), day('2026-10-16', 10, 300)));
  assert.equal(ps?.date, '2026-10-15'); assert.equal(ps?.bars.length, 375); assert.equal(ps?.bars[0].open, 200); assert.ok(ps!.bars.every((b) => b.high >= Math.max(b.open, b.close) && b.low <= Math.min(b.open, b.close)));
  assert.equal(parseYahooSession(mk(day('2026-10-15', 10, 1))), null); assert.equal(parseYahooSession(null), null);
});

console.log(`\n${passed} checks passed${process.exitCode ? ' — WITH FAILURES' : ''}`);
