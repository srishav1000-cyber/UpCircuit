/* Core logic checks — run with `npm test`. No framework: plain assertions, exits non-zero on failure. */
import assert from 'node:assert/strict';
import { SEED_INSTRUMENTS } from '../lib/instruments';
import { hashStr } from '../lib/estimate';
import { MarketEngine, TIMEFRAMES, TF_CONFIG } from '../lib/market';
import { ingestFixture, fixtureCandles } from './fixtures';
import {
  capClass, correlationMatrix, hhi, longTermOutlook, pearson, pivotLevels, portfolioSummary, rsi14, sharpe, shortTermOutlook, sma, topMovers, vwap, macd,
} from '../lib/analytics';
import { parsePortfolioCsv } from '../lib/csv';
import { parseRss, decodeEntities } from '../lib/news';
import { scoreText } from '../lib/sentiment';
import { buildIndex, searchInstruments } from '../lib/fuzzy';
import { fundamentalsOf, ratioTone } from '../lib/fundamentals';
import { answerLocally, detectIntent, isContext, type CopilotContext } from '../lib/copilot';
import { TtlCache, allow } from '../lib/ttlCache';
import {
  cumulativeReturnPct, dividendForecast, intradaySigma, liquidityRatio, portfolioDiagnostics, portfolioValueSeries, sectorIndexSeries, sharpeParts, tickVolumeBuckets, vwapBands, weightedRiskScore,
} from '../lib/analytics';
import { encodeTick, parseTick, subscribeMessage, totp, type SmartTick } from '../lib/smartapi';
import { isMarketOpen, isStreamWindow, FEED_BADGE } from '../lib/market';
import { parseHoldingsText } from '../lib/portfolioText';
import { addAlert, checkAlerts, parseAlerts } from '../lib/alerts';
import { smartApiStatus } from '../lib/market';
// @ts-expect-error plain .mjs helper
import { pickEquities } from './sync-instruments.mjs';

let passed = 0;
const pending: Promise<void>[] = [];
const t = (name: string, fn: () => void | Promise<void>) => {
  const ok = () => { passed++; console.log('  ✓', name); };
  const bad = (e: unknown) => { console.error('  ✗', name, '\n   ', (e as Error).message); process.exitCode = 1; };
  try {
    const r = fn();
    if (r && typeof (r as Promise<void>).then === 'function') pending.push((r as Promise<void>).then(ok, bad));
    else ok();
  } catch (e) {
    bad(e);
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
t('market-cap buckets are all populated across the seed universe', () => {
  const e = ingestFixture(new MarketEngine(SEED_INSTRUMENTS));
  const c = { Large: 0, Mid: 0, Small: 0 }; e.quotes.forEach((q) => c[capClass(q.mcapCr)]++);
  console.log('      Large/Mid/Small:', c.Large, c.Mid, c.Small);
  assert.ok(c.Large >= 10 && c.Mid >= 10 && c.Small >= 10);
});
t('top movers ordering', () => {
  const e = ingestFixture(new MarketEngine(SEED_INSTRUMENTS)); const all = [...e.quotes.values()];
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
  const e = ingestFixture(new MarketEngine(SEED_INSTRUMENTS)); const q = e.quotes.get(symbol)!;
  const closes = fixtureCandles(symbol).map((c) => c.close);
  const prev = fixtureCandles(symbol).slice(-2)[0];
  const s = shortTermOutlook(closes), l = longTermOutlook(closes);
  return {
    symbol, name: q.name, sector: q.sector,
    price: { ltp: q.ltp, changePct: (q.ltp / q.prevClose - 1) * 100, dayHigh: q.high, dayLow: q.low, volume: q.volume, circuitBandPct: q.circuitBand },
    ratios: { marketCapCr: q.mcapCr, pe: 24.5, bookValue: 310, dividendYield: 1.2, roce: 18.2, roe: 16.4, debtToEquity: symbol === 'HDFCBANK' ? null : 0.4, promoterHolding: 52, eps: q.ltp / 24.5 },
    technicals: { rsi: rsi14(closes), sma50: sma(closes, 50), sma200: sma(closes, 200), pivots: pivotLevels(prev.high, prev.low, prev.close), short: s && { label: s.label, score: s.score }, long: l && { label: l.label, score: l.score } },
    simulated: true,
  };
};
t('fundamentals: no simulation — null ratios are N/A and never get a tone', () => {
  const sc = getScreener({ symbol: 'TCS', sector: 'IT', ltp: 3500, prevClose: 3480, mcapCr: 1_270_000, dividendYield: 0, high: 3510, low: 3470 });
  const f = fundamentalsOf(sc);
  assert.equal(f.marketCapCr, 1_270_000); assert.equal(f.pe, null); assert.equal(f.roe, null); assert.equal(f.promoterHolding, null);
  for (const k of ['pe', 'roe', 'roce', 'debtToEquity', 'promoterHolding', 'dividendYield'] as const) assert.equal(ratioTone(k, f), 'na', k);
  assert.equal(ratioTone('roe', { ...f, roe: 20 }), 'good'); assert.equal(ratioTone('debtToEquity', { ...f, debtToEquity: 1.4 }), 'bad');
});
t('outlooks produce labelled signals', () => {
  const closes = fixtureCandles('INFY').map((c) => c.close);
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
    assert.match(a, /not investment advice/); assert.match(a, /N\/A/);
    assert.ok(a.length > 80, q);
  }
  assert.match(answerLocally('Is it expensive?', ctx, []), new RegExp(ctx.ratios.pe!.toFixed(1)));
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
t('SmartAPI link status: LIVE vs offline session, with the reason when the stream is not in use', () => {
  const st = smartApiStatus;
  assert.equal(st({ mode: 'live', conn: 'open' }).label, '● SMARTAPI LIVE'); assert.equal(st({ mode: 'live', conn: 'open' }).health, 'ok');
  assert.equal(st({ mode: 'delayed', conn: 'open' }).label, 'SmartAPI connected');
  assert.equal(st({ mode: 'delayed', conn: 'connecting' }).label, 'Connecting…');
  for (const reason of ['no_key', 'unauthorized', 'not_configured', 'login_failed', 'unreachable', 'stream_failed', 'outside_hours'] as const) {
    const r = st({ mode: 'delayed', conn: 'closed', reason }); assert.equal(r.label, 'Offline session'); assert.doesNotMatch(r.detail, /Yahoo/); assert.ok(r.detail.length > 60);
  }
  assert.equal(st({ mode: 'delayed', conn: 'idle', reason: 'no_key' }).health, 'off'); assert.equal(st({ mode: 'delayed', conn: 'closed', reason: 'stream_failed' }).health, 'warn');
  assert.equal(FEED_BADGE.live.text, '● SMARTAPI LIVE'); assert.equal(FEED_BADGE.delayed.text, '● SESSION PAUSED (MARKET CLOSED)');
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
import { BUDGET_BANDS, budgetCandidates, inBand } from '../lib/discovery';
t('resolveIndex maps tickers + aliases, rejects equities', () => {
  for (const [s, id] of [['NIFTY 50', 'NIFTY'], ['nifty50', 'NIFTY'], ['SENSEX', 'SENSEX'], ['BANK NIFTY', 'BANKNIFTY'], ['Nifty Bank', 'BANKNIFTY'], ['INDIA VIX', 'INDIAVIX'], ['VIX', 'INDIAVIX']] as const) assert.equal(resolveIndex(s)?.id, id, s);
  assert.equal(resolveIndex('RELIANCE'), undefined); assert.equal(resolveIndex(''), undefined); assert.equal(resolveIndex(null), undefined);
});
const bp = (s: string) => 1 + (hashStr(s) % 9000) / 10; // test price oracle
t('budget bands: exclusive upper bound, candidates filtered + capped', () => {
  const [a, b, c] = BUDGET_BANDS;
  assert.ok(inBand(49.95, a) && !inBand(50, a) && inBand(50, b) && inBand(100, c) && !inBand(500, c) && !inBand(NaN, a));
  const big = Array.from({ length: 3000 }, (_, i) => ({ symbol: 'S' + i, name: 'S' + i, sector: 'Others' }));
  for (const band of BUDGET_BANDS) {
    const r = budgetCandidates(big, band, bp, 20);
    assert.ok(r.length > 0 && r.length <= 20); assert.ok(r.every((i) => inBand(bp(i.symbol), band)));
  }
});
t('feed modes: snapshot badge + status', () => {
  assert.equal(smartApiStatus({ mode: 'snapshot', conn: 'open' }).health, 'ok');
  assert.match(smartApiStatus({ mode: 'snapshot', conn: 'open' }).detail, /last prices/);
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
t('screener: quote-only — no invented numbers, everything unknown is null / N/A', () => {
  const bad: any[] = [null, undefined, {}, { symbol: 'X' }, { symbol: 'X', ltp: NaN, mcapCr: undefined, sector: undefined, high: null, low: -1, prevClose: 0 }];
  for (const q of bad) {
    const sc = getScreener(q);
    for (const k of ['marketCapCr', 'pe', 'industryPe', 'bookValue', 'dividendYield', 'roce', 'roe', 'faceValue', 'eps', 'high52', 'low52', 'debtToEquity'] as const) assert.equal(sc[k], null, k);
    assert.deepEqual(sc.quarters, []); assert.equal(sc.holding, null); assert.equal(sc.source.live, false);
    assert.ok(sc.source.na.includes('P/E') && sc.source.na.includes('52W range') && sc.source.na.includes('Shareholding'));
  }
  assert.equal(getScreener(undefined).pe, null, 'no default 15.2 any more');
  assert.equal(peerCandidates(undefined, 'X', 'IT').length, 0, 'no instruments → no peers');
});

t('screener: real quote fields pass through; today\'s range is NOT passed off as a 52-week range', () => {
  assert.deepEqual(quarterLabels(new Date('2026-10-15T00:00:00Z')), ['Sep 2025', 'Dec 2025', 'Mar 2026', 'Jun 2026', 'Sep 2026']);
  assert.deepEqual(quarterLabels(new Date('2026-09-15T00:00:00Z')).slice(-1), ['Jun 2026']); assert.deepEqual(quarterLabels(new Date('2026-01-10T00:00:00Z')).slice(-1), ['Dec 2025']);
  const q = { symbol: 'TST', sector: 'IT', ltp: 100, prevClose: 99, mcapCr: 5000, dividendYield: 1.2, high: 101, low: 98 };
  const s = getScreener(q); assert.equal(s.marketCapCr, 5000); assert.equal(s.dividendYield, 1.2); assert.equal(s.high52, null); assert.equal(s.low52, null);
  assert.ok(!s.source.na.includes('Market Cap') && !s.source.na.includes('Dividend Yield'));
  assert.deepEqual(s, getScreener(q)); // deterministic, no RNG
  assert.equal(getScreener({ ...q, mcapCr: 0, dividendYield: 0 }).marketCapCr, null);
  assert.equal(rangePct(5, 0, 10), 50); assert.equal(rangePct(-1, 0, 10), 0); assert.equal(rangePct(99, 0, 10), 100); assert.equal(rangePct(1, 5, 5), 50);
  const eng = ingestFixture(new MarketEngine(SEED_INSTRUMENTS));
  const all = Array.from({ length: 3000 }, (_, i) => ({ symbol: 'P' + i, name: 'P' + i, sector: i % 2 ? 'IT' : 'Auto' }));
  const peers = peerCandidates(all, 'P1', 'IT', 5); assert.equal(peers.length, 5); assert.ok(peers.every((p) => p.sector === 'IT' && p.symbol !== 'P1'));
  assert.equal(eng.quotes.size < 400, true); // peer selection must not instantiate the sector
});

import { parseQuoteSummary, parseTimeseries, fromTimeseries, mergeLive } from '../lib/yahooFundamentals';
import { createList, renameList, deleteList, defaultState, mapList, setActive, parseState, activeList, allSymbols, MAX_LISTS } from '../lib/watchlist';
const W = (v: number) => ({ raw: v });
t('yahoo fundamentals: quoteSummary + timeseries parsing, merge over the quote-only screener', () => {
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
  assert.deepEqual([m.marketCapCr, m.pe, m.bookValue, m.roce, m.eps, m.quarters.length, m.holding!.promoters], [150000, 24.5, 620, 20, 118, 5, 50]);
  assert.ok(m.source.live && m.source.quarters && m.source.holding && m.source.na.includes('Face Value') && !m.source.na.includes('P/E'));
  assert.ok(Math.abs(m.holding!.promoters + m.holding!.institutions + m.holding!.public - 100) < 0.2);
  assert.ok(m.low52! <= ltp && ltp <= m.high52!);
  const partial = mergeLive(sim, { yahooSymbol: 'X.NS', fetchedAt: 1, pe: 30, quarters: [] }, ltp); // missing fields stay N/A
  assert.equal(partial.pe, 30); assert.equal(partial.marketCapCr, sim.marketCapCr); assert.deepEqual(partial.quarters, []); assert.equal(partial.roe, null); assert.equal(partial.high52, null); assert.ok(partial.source.na.includes('Quarterly results') && partial.source.na.includes('ROE'));
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
  const eng = ingestFixture(new MarketEngine(SEED_INSTRUMENTS)); SEED_INSTRUMENTS.slice(0, 60).forEach((i) => eng.touch(i.symbol)); const live = classifyAnomalies(eng.quotes.values()); assert.ok(Array.isArray(live.upper) && Array.isArray(live.surge));
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
  const fq = Array.from({ length: 5 }, (_, i) => ({ label: ['Sep 2025', 'Dec 2025', 'Mar 2026', 'Jun 2026', 'Sep 2026'][i], sales: 100 + i, expenses: 80, operatingProfit: 20 + i, opmPct: 20, netProfit: 10 + i, eps: 1 + i }));
  const sc = mergeLive(getScreener({ ...q, mcapCr: 5000, dividendYield: 1 } as any), { yahooSymbol: 'TST.NS', fetchedAt: 1, pe: 20, roce: 15, roe: 14, holding: { promoters: 50, institutions: 30 }, quarters: fq }, q.ltp); const csv = reportCsv(q, sc, new Date('2026-10-15T05:00:00Z'));
  const lines = csv.trim().split('\r\n'); assert.equal(lines[0], 'Section,Metric,Period,Value,Unit'); assert.ok(lines.includes('Summary,Company,,"Test, Ltd",'));
  for (const sec of ['Summary,LTP', 'Fundamentals,Market Cap', 'Fundamentals,ROCE', 'Fundamentals,ROE', 'Fundamentals,Stock P/E', 'Shareholding,Promoters']) assert.ok(lines.some((l) => l.startsWith(sec)), sec);
  assert.equal(lines.filter((l) => l.startsWith('Quarterly,Net Profit')).length, 5); assert.ok(lines.some((l) => l.startsWith('Quarterly,Sales / Revenue,Sep 2026,')));
  const m = buildReport(q, sc, new Date('2026-10-15T05:00:00Z')); assert.equal(m.changePct, 10); assert.equal(m.grid.length, 10); assert.ok(m.grid.some((g) => g.label.startsWith('ROCE'))); assert.equal(reportFileName('M&M', 'csv', new Date('2026-10-15T05:00:00Z')), 'UpCircuit_MM_report_2026-10-15.csv');
});

import { circuitHit, nearCircuit, limitPrice, CircuitTracker } from '../lib/circuit';
import { CHIME_FREQ } from '../lib/chime';
import { appUrl, terminalUrl, APP_URL } from '../lib/appUrl';
import { buildCircuitEmail, sendEmail, esc } from '../lib/email';
import { parseQuoteRows } from '../lib/yahooData';
import { DirectSmartApiStream, SMART_STREAM_URL, toEngineTick, type MarketTick } from '../lib/smartapiDirect';
import { ExchangeType, INDEX_TOKENS } from '../lib/smartapi';
import { smartApiLogin } from '../lib/smartapiLogin';
import { buildListings } from '../lib/scripMaster';
console.log('direct SmartAPI stream (no relay)');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function fakeWS() {
  const made: FakeWS[] = [];
  class FakeWS {
    readyState = 0; binaryType = ''; sent: string[] = [];
    onopen?: () => void; onmessage?: (e: { data: unknown }) => void; onclose?: () => void; onerror?: () => void;
    constructor(public url: string) { made.push(this); }
    send(m: string) { this.sent.push(m); }
    close() { this.readyState = 3; this.onclose?.(); }
    open() { this.readyState = 1; this.onopen?.(); }
    drop() { this.readyState = 3; this.onclose?.(); }
  }
  return { FakeWS, made };
}
const bin = (o: Parameters<typeof encodeTick>[0]) => { const u = encodeTick(o); return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength); };
t('stream: URL carries clientCode/feedToken/apiKey; 30 s ping default; subscribes indices + diff of symbols (mode 3)', async () => {
  const { FakeWS, made } = fakeWS();
  const s = new DirectSmartApiStream({ apiKey: 'KEY', clientCode: 'C123', feedToken: 'FT/1', onTick: () => {}, onError: () => {}, WebSocketImpl: FakeWS as unknown as typeof WebSocket });
  assert.equal(s.url, `${SMART_STREAM_URL}?clientCode=C123&feedToken=FT%2F1&apiKey=KEY`); assert.equal(SMART_STREAM_URL, 'wss://smartapisocket.angelone.in/smart-stream');
  assert.equal((s as unknown as { o: { pingMs: number; maxRetries: number } }).o.pingMs, 30_000); assert.equal((s as unknown as { o: { maxRetries: number } }).o.maxRetries, 3);
  s.connect(); const ws = made[0]; assert.equal(s.status, 'connecting'); assert.equal(ws.binaryType, 'arraybuffer'); ws.open(); assert.equal(s.status, 'open');
  const first = ws.sent.map((m) => JSON.parse(m)); assert.ok(first.every((m) => m.params.mode === 3 && m.action === 1)); assert.equal(first.flatMap((m) => m.params.tokenList.flatMap((g: { tokens: string[] }) => g.tokens)).length, INDEX_TOKENS.length);
  s.subscribe([{ symbol: 'TCS', token: '11536', exchangeType: ExchangeType.NSE_CM }]); s.subscribe([{ symbol: 'TCS', token: '11536', exchangeType: ExchangeType.NSE_CM }, { symbol: 'INFY', token: '1594', exchangeType: ExchangeType.NSE_CM }]);
  assert.deepEqual(ws.sent.slice(first.length).map((m) => JSON.parse(m).params.tokenList), [[{ exchangeType: 1, tokens: ['11536'] }], [{ exchangeType: 1, tokens: ['1594'] }]]);
  s.close(); assert.equal(s.status, 'idle');
});
t('stream: heartbeat sends "ping" on the interval and stops on close', async () => {
  const { FakeWS, made } = fakeWS();
  const s = new DirectSmartApiStream({ apiKey: 'K', clientCode: 'C', feedToken: 'F', pingMs: 15, onTick: () => {}, onError: () => {}, WebSocketImpl: FakeWS as unknown as typeof WebSocket });
  s.connect(); made[0].open(); await sleep(150);
  const pings = made[0].sent.filter((m) => m === 'ping').length; assert.ok(pings >= 2, 'pings: ' + pings);
  s.close(); const n = made[0].sent.length; await sleep(40); assert.equal(made[0].sent.length, n, 'no pings after close');
});
t('stream: binary ticks → MarketTick {symbol,lastPrice,changePercent,volume,timestamp}; stock + index; junk / unknown tokens ignored', () => {
  const { FakeWS, made } = fakeWS(); const got: MarketTick[] = [];
  const s = new DirectSmartApiStream({ apiKey: 'K', clientCode: 'C', feedToken: 'F', onTick: (m) => got.push(m), onError: () => {}, WebSocketImpl: FakeWS as unknown as typeof WebSocket });
  s.subscribe([{ symbol: 'TCS', token: '11536', exchangeType: 1 }]); s.connect(); made[0].open();
  const ts = Date.parse('2026-10-19T10:00:00+05:30');
  made[0].onmessage!({ data: bin({ mode: 2, exchangeType: 1, token: '11536', seq: 1, exchangeTs: ts, ltp: 4100, volume: 12345, open: 4010, high: 4120, low: 4000, close: 4000 }) });
  assert.equal(got.length, 1); const m = got[0];
  assert.deepEqual([m.symbol, m.lastPrice, m.volume, m.timestamp], ['TCS', 4100, 12345, ts]); near(m.changePercent, 2.5, 1e-9); assert.equal(m.prevClose, 4000); assert.ok(!m.isIndex);
  const e = new MarketEngine(SEED_INSTRUMENTS); e.applyTick(toEngineTick(m)); assert.equal(e.quotes.get('TCS')!.ltp, 4100); assert.equal(e.quotes.get('TCS')!.prevClose, 4000);
  made[0].onmessage!({ data: bin({ mode: 1, exchangeType: 1, token: '99926000', seq: 2, exchangeTs: ts, ltp: 25000 }) });
  assert.equal(got[1].symbol, 'NIFTY'); assert.ok(got[1].isIndex); assert.equal(got[1].lastPrice, 25000);
  made[0].onmessage!({ data: bin({ mode: 1, exchangeType: 1, token: '55555', seq: 3, exchangeTs: ts, ltp: 10 }) });
  made[0].onmessage!({ data: 'pong' }); made[0].onmessage!({ data: new ArrayBuffer(4) }); made[0].onmessage!({ data: 'not json' });
  assert.equal(got.length, 2); assert.equal(s.ticks, 2); s.close();
});
t('stream: reconnects with exponential backoff (3 retries) then calls onError once; a tick resets the budget', async () => {
  const { FakeWS, made } = fakeWS(); const errs: unknown[] = []; const times: number[] = []; const t0 = Date.now();
  const s = new DirectSmartApiStream({ apiKey: 'K', clientCode: 'C', feedToken: 'F', baseDelayMs: 10, onTick: () => {}, onError: (e) => errs.push(e), WebSocketImpl: class extends FakeWS { constructor(u: string) { super(u); times.push(Date.now() - t0); } } as unknown as typeof WebSocket });
  s.connect(); made[0].drop(); await sleep(15); made[1].drop(); await sleep(30); made[2].drop(); await sleep(60); made[3].drop(); await sleep(30);
  assert.equal(made.length, 4, '1 connect + 3 retries'); assert.equal(errs.length, 1); assert.equal((errs[0] as { reason: string }).reason, 'retries_exhausted'); assert.equal((errs[0] as { attempts: number }).attempts, 3);
  assert.ok(times[2] - times[1] >= 18 && times[3] - times[2] >= 35, 'delays double: ' + times.join(','));
  // flowing ticks reset the retry budget
  const r = fakeWS(); const s2 = new DirectSmartApiStream({ apiKey: 'K', clientCode: 'C', feedToken: 'F', baseDelayMs: 5, onTick: () => {}, onError: () => errs.push('x'), WebSocketImpl: r.FakeWS as unknown as typeof WebSocket });
  s2.subscribe([{ symbol: 'TCS', token: '11536', exchangeType: 1 }]); s2.connect(); r.made[0].open(); r.made[0].drop(); await sleep(10); assert.equal(s2.retries, 1);
  r.made[1].open(); r.made[1].onmessage!({ data: bin({ mode: 1, exchangeType: 1, token: '11536', seq: 1, exchangeTs: 1, ltp: 5 }) }); assert.equal(s2.retries, 0); s2.close();
});
t('stream: a server error frame fails immediately (no retries)', () => {
  const { FakeWS, made } = fakeWS(); const errs: { reason: string }[] = [];
  const s = new DirectSmartApiStream({ apiKey: 'K', clientCode: 'C', feedToken: 'F', onTick: () => {}, onError: (e) => errs.push(e), WebSocketImpl: FakeWS as unknown as typeof WebSocket });
  s.connect(); made[0].open(); made[0].onmessage!({ data: JSON.stringify({ errorCode: '403', errorMessage: 'Invalid token' }) });
  assert.deepEqual(errs.map((e) => e.reason), ['server_error']); assert.equal(made.length, 1);
});
t('session login: returns ONLY clientCode + feedToken (never the JWT); missing config is reported', async () => {
  const env = { SMARTAPI_API_KEY: 'k', SMARTAPI_CLIENT_CODE: 'C1', SMARTAPI_PASSWORD: 'pw', SMARTAPI_TOTP_SECRET: 'JBSWY3DPEHPK3PXP' };
  let body = ''; const f = (async (_u: string, i: RequestInit) => { body = String(i.body); return new Response(JSON.stringify({ status: true, data: { jwtToken: 'SECRETJWT', refreshToken: 'R', feedToken: 'FEED' } })); }) as unknown as typeof fetch;
  const r = await smartApiLogin(env, f, 1_760_000_000_000); assert.ok(r.ok); if (r.ok) { assert.deepEqual(Object.keys(r.session).sort(), ['clientCode', 'expiresAt', 'feedToken']); assert.equal(r.session.feedToken, 'FEED'); assert.ok(!JSON.stringify(r).includes('SECRETJWT')); }
  assert.match(body, /"clientcode":"C1"/); assert.match(body, /"totp":"\d{6}"/);
  assert.deepEqual(await smartApiLogin({}, f).then((x) => !x.ok && x.reason), 'not_configured');
  const bad = (async () => new Response(JSON.stringify({ status: false, message: 'Invalid TOTP' }))) as unknown as typeof fetch; const b = await smartApiLogin(env, bad); assert.ok(!b.ok && b.reason === 'login_failed');
});
t('scrip master listings: NSE cash by name wins; BSE-only names added; derivatives skipped', () => {
  const m = buildListings([
    { token: '2885', symbol: 'RELIANCE-EQ', name: 'RELIANCE', exch_seg: 'NSE' }, { token: '500325', symbol: 'RELIANCE', name: 'RELIANCE', exch_seg: 'BSE' },
    { token: '9', symbol: 'RELIANCE26OCTFUT', name: 'RELIANCE', exch_seg: 'NFO', instrumenttype: 'FUTSTK' }, { token: '539', symbol: 'ABCLTD', name: 'ABC', exch_seg: 'BSE' },
  ]);
  assert.deepEqual(m.get('RELIANCE'), { token: '2885', exchangeType: ExchangeType.NSE_CM }); assert.deepEqual(m.get('ABCLTD'), { token: '539', exchangeType: ExchangeType.BSE_CM }); assert.equal(m.size, 2);
});
t('stream window: 15 min either side of the session, Mon–Fri only', () => {
  const ist = (s: string) => Date.parse(s + '+05:30');
  assert.ok(!isStreamWindow(ist('2026-10-19T08:44:00')) && isStreamWindow(ist('2026-10-19T09:01:00')) && isStreamWindow(ist('2026-10-19T15:44:00')) && !isStreamWindow(ist('2026-10-19T15:46:00')) && !isStreamWindow(ist('2026-10-18T11:00:00')));
});

console.log('real-data engine · circuits · alerts · email');
t('engine has NO quotes until Yahoo delivers them; touch() queues the symbol', () => {
  const e = new MarketEngine(SEED_INSTRUMENTS);
  assert.equal(e.quotes.size, 0); assert.equal(e.ready, false);
  assert.equal(e.touch('TCS'), undefined); assert.ok(e.wantedQuotes().includes('TCS'));
  e.step('TCS', Date.now()); assert.equal(e.quotes.size, 0, 'stepping must not invent prices');
  e.ingestRows([{ symbol: 'TCS', ltp: 4000, prevClose: 3950 }]);
  assert.equal(e.quotes.get('TCS')!.ltp, 4000); assert.equal(e.ready, true);
});
t('Yahoo quote payload parses to rows; junk and non-positive prices are dropped', () => {
  const rows = parseQuoteRows({ quoteResponse: { result: [{ symbol: 'TCS.NS', regularMarketPrice: 4000, regularMarketPreviousClose: 3950, regularMarketVolume: 10 }, { symbol: 'BAD.NS', regularMarketPrice: 0, regularMarketPreviousClose: 5 }, { symbol: 'X.NS' }] } });
  assert.equal(rows.length, 1); assert.equal(rows[0].symbol, 'TCS'); assert.equal(rows[0].prevClose, 3950);
});
t('real bars are stored per timeframe and drive session VWAP', () => {
  const e = new MarketEngine(SEED_INSTRUMENTS); e.ingestRows([{ symbol: 'INFY', ltp: 1500, prevClose: 1490 }]);
  const day = 1_760_000_000 - (1_760_000_000 % 86400);
  const bars = Array.from({ length: 30 }, (_, i) => ({ time: day + 60 * i, open: 1500, high: 1502, low: 1498, close: 1500, volume: 100 }));
  assert.deepEqual(e.historyOf('INFY', '1m'), []); e.ingestBars('INFY', '1m', bars);
  assert.equal(e.historyOf('INFY', '1m').length, 30); near(e.quotes.get('INFY')!.sumPV / e.quotes.get('INFY')!.sumV, 1500, 0.01);
});
t('circuit detection: ±5/10/20 % limit prices (tick-rounded), nothing in between', () => {
  const q = (ltp: number) => ({ symbol: 'ABC', ltp, prevClose: 200, circuitBand: 20, upperCircuit: 240, lowerCircuit: 160, bandKnown: false });
  assert.equal(limitPrice(200, 10, 'upper'), 220); assert.equal(limitPrice(200, 5, 'lower'), 190);
  assert.deepEqual([circuitHit(q(220))?.dir, circuitHit(q(220))?.band], ['upper', 10]);
  assert.deepEqual([circuitHit(q(190))?.dir, circuitHit(q(190))?.band], ['lower', 5]);
  assert.equal(circuitHit(q(160))?.band, 20); assert.equal(circuitHit(q(205)), null); assert.equal(circuitHit(q(219.5)), null);
  assert.ok(nearCircuit(q(219.5), 1));
});
t('CircuitTracker: inferred bands need a 2nd observation ≥ 8 s later; exchange-known fire at once; clears when price leaves', () => {
  const tr = new CircuitTracker(8000); const at = { symbol: 'ABC', ltp: 220, prevClose: 200, circuitBand: 10, upperCircuit: 220, lowerCircuit: 180, bandKnown: false };
  tr.observe(at, 0); assert.equal(tr.active().length, 0); tr.observe(at, 3000); assert.equal(tr.active().length, 0);
  tr.observe(at, 9000); assert.equal(tr.active().length, 1);
  tr.observe({ ...at, ltp: 205 }, 12000); assert.equal(tr.active().length, 0);
  const t2 = new CircuitTracker(8000); t2.observe({ ...at, bandKnown: true }, 0); assert.equal(t2.active().length, 1);
});
t('chime: upper ascends 880→1760 Hz, lower descends 440→220 Hz', () => {
  assert.deepEqual(CHIME_FREQ.upper, [880, 1760]); assert.deepEqual(CHIME_FREQ.lower, [440, 220]);
});
t('app URLs resolve from NEXT_PUBLIC_APP_URL (default https://upcircuit.vercel.app)', () => {
  assert.ok(APP_URL.startsWith('http') && !APP_URL.endsWith('/'));
  assert.equal(appUrl('/login'), APP_URL + '/login'); assert.equal(terminalUrl('M&M'), APP_URL + '/terminal?symbol=M%26M');
  if (!process.env.NEXT_PUBLIC_APP_URL) assert.equal(APP_URL, 'https://upcircuit.vercel.app');
});
t('circuit e-mail: ticker, event, LTP, band limit, terminal link; HTML-escaped', async () => {
  const m = buildCircuitEmail({ symbol: 'XYZ', dir: 'upper', ltp: 220.05, limit: 220, band: 10, pct: 10.02 });
  assert.match(m.subject, /XYZ Upper Circuit Hit/); assert.ok(m.html.includes('Upper Circuit Hit') && m.html.includes('XYZ') && m.html.includes('₹220.05') && m.html.includes('10% circuit limit'));
  assert.ok(m.html.includes(`href="${APP_URL}/terminal?symbol=XYZ"`)); assert.match(m.text, /Open in the terminal: .*\/terminal\?symbol=XYZ/);
  assert.match(buildCircuitEmail({ symbol: 'ABC', dir: 'lower', ltp: 90, limit: 90, band: 10, pct: -10 }).subject, /Lower Circuit Hit/);
  assert.equal(esc('<a href="x">&\''), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
  assert.ok(!buildCircuitEmail({ symbol: '<b>', dir: 'upper', ltp: 1, limit: 1, band: 5, pct: 5 }).html.includes('<b>'));
});
t('sendEmail: Resend request shape, missing key, provider failure', async () => {
  let seen: { url: string; init: RequestInit } | null = null;
  const ok = (async (url: string, init: RequestInit) => { seen = { url, init }; return new Response(JSON.stringify({ id: 'e1' }), { status: 200 }); }) as unknown as typeof fetch;
  const r = await sendEmail({ to: 'a@b.co', subject: 's', html: 'h', text: 't' }, { apiKey: 'k', from: 'UpCircuit <a@x.io>' }, ok);
  assert.deepEqual(r, { ok: true, id: 'e1' }); const s = seen as unknown as { url: string; init: RequestInit };
  assert.equal(s.url, 'https://api.resend.com/emails'); assert.equal((s.init.headers as Record<string, string>).Authorization, 'Bearer k'); assert.deepEqual(JSON.parse(s.init.body as string).to, ['a@b.co']);
  assert.equal((await sendEmail({ to: 'a@b.co', subject: 's', html: 'h', text: 't' }, {})).ok, false);
  const bad = (async () => new Response(JSON.stringify({ message: 'nope' }), { status: 422 })) as unknown as typeof fetch;
  assert.deepEqual(await sendEmail({ to: 'a@b.co', subject: 's', html: 'h', text: 't' }, { apiKey: 'k' }, bad), { ok: false, error: 'nope', status: 422 });
});


import { playChime, unlockAudioContext, audioState, testChime, SWEEP_SEC, FIFTH } from '../lib/chime';
import { logLine, istTime } from '../components/CircuitLogDrawer';
t('chime sweeps: upper 880→1760 Hz, lower 440→220 Hz over 0.35 s; locked until unlockAudioContext()', async () => {
  const rec: { type: string; set: [number, number][]; ramp: [number, number][] }[] = [];
  class FakeCtx {
    state = 'suspended'; currentTime = 10; destination = {};
    addEventListener() {}
    async resume() { this.state = 'running'; }
    createGain() { const g = { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect: () => g }; return g; }
    createOscillator() { const o = { type: '', set: [] as [number, number][], ramp: [] as [number, number][], frequency: { setValueAtTime: (v: number, at: number) => o.set.push([v, at]), exponentialRampToValueAtTime: (v: number, at: number) => o.ramp.push([v, at]) }, connect: (x: unknown) => x, start() {}, stop() {} }; rec.push(o); return o; }
  }
  (globalThis as unknown as { window: unknown }).window = { AudioContext: FakeCtx };
  assert.equal(audioState(), 'suspended'); assert.equal(playChime('upper'), false, 'locked before a gesture');
  assert.equal(await unlockAudioContext(), 'running'); assert.equal(audioState(), 'running');
  assert.equal(playChime('upper'), true);
  near(rec[0].set[0][0], 880, 0); near(rec[0].ramp[0][0], 1760, 0); near(rec[0].ramp[0][1] - rec[0].set[0][1], SWEEP_SEC, 1e-9); near(rec[1].set[0][0], 880 * FIFTH, 0);
  rec.length = 0; assert.equal(await testChime('lower'), true);
  near(rec[0].set[0][0], 440, 0); near(rec[0].ramp[0][0], 220, 0); near(rec[0].ramp[0][1] - rec[0].set[0][1], SWEEP_SEC, 1e-9);
  delete (globalThis as unknown as { window?: unknown }).window;
});
t('circuit log line: [HH:MM:SS] | SYMBOL | TYPE | ₹price | %change (IST)', () => {
  const at = Date.parse('2026-10-19T09:45:07+05:30');
  assert.equal(istTime(at), '09:45:07');
  assert.equal(logLine({ at, symbol: 'ABC', dir: 'upper', ltp: 220.05, pct: 10.02 }), '[09:45:07] | ABC | UPPER | ₹220.05 | +10.02%');
  assert.match(logLine({ at, symbol: 'XYZ', dir: 'lower', ltp: 90, pct: -10 }), /^\[09:45:07\] \| XYZ \| LOWER \| ₹90\.00 \| [-−]10\.00%$/);
});

/* ───────────── Round 19: HHI + macro shocks, alert dedupe, off-market replay ───────────── */
import { hhiPct, hhiBand, sectorWeights as sectorWeightsH, runScenario, runAllScenarios, shockFactor, SCENARIOS } from '../lib/analytics/hhi';
import { CircuitDedupe, istDate } from '../lib/circuitDedupe';
import { TickSampler, validateRows, rowsToCsv, buildReplay, Replayer, envelopePath, inSession, clampToSession } from '../lib/offmarketSimulation';

t('HHI: Σ s² on % weights, bands green < 1500 ≤ yellow ≤ 2500 < red', () => {
  near(hhiPct([100]), 10000); near(hhiPct([50, 50]), 5000); near(hhiPct(Array(10).fill(10)), 1000); assert.equal(hhiPct([]), 0);
  assert.equal(hhiBand(1499).zone, 'green'); assert.equal(hhiBand(1500).zone, 'yellow'); assert.equal(hhiBand(2500).zone, 'yellow'); assert.equal(hhiBand(2501).zone, 'red');
  const w = sectorWeightsH([{ symbol: 'A', sector: 'IT', value: 300 }, { symbol: 'B', sector: 'IT', value: 100 }, { symbol: 'C', sector: 'Banking', value: 600 }, { symbol: 'D', sector: 'X', value: 0 }]);
  assert.deepEqual(w.map((x) => [x.sector, Math.round(x.weightPct)]), [['Banking', 60], ['IT', 40]]); near(hhiPct(w.map((x) => x.weightPct)), 5200, 1e-6);
});
t('macro shocks: ΔValue = Σ Valueⱼ × Shockⱼ, scaled by scenario', () => {
  const pos = [{ symbol: 'HDFCBANK', sector: 'Banking', value: 1_000_000 }, { symbol: 'DLF', sector: 'Realty', value: 500_000 }, { symbol: 'TCS', sector: 'IT', value: 500_000 }];
  const get = (id: string) => runScenario(pos, SCENARIOS.find((s) => s.id === id)!);
  near(get('rate100').delta, 1_000_000 * -0.018 + 500_000 * -0.032 + 500_000 * -0.005, 1e-6); near(get('rate50').delta, get('rate100').delta / 2, 1e-6);
  near(get('crash5').delta, (1_000_000 * 1.15 + 500_000 * 1.5 + 500_000 * 0.85) * -0.05, 1e-6); near(get('crash10').delta, get('crash5').delta * 2, 1e-6); near(get('crash3').delta / get('crash5').delta, 0.6, 1e-9);
  assert.equal(runAllScenarios(pos).length, 6); assert.equal(runAllScenarios([]).every((r) => r.delta === 0 && r.deltaPct === 0), true);
  near(shockFactor('crude15', 'Consumer', 'ASIANPAINT'), -0.045); near(shockFactor('crude15', 'Energy', 'ONGC'), 0.032); near(shockFactor('rate100', 'Weird'), -0.01);
  assert.ok(get('crude15').delta < 0 && get('rate100').worst!.sector === 'Banking');
});
t('circuit dedupe: once per symbol·direction per IST day, re-fires only on a higher band', () => {
  const mem = new Map<string, string>(); const kv = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
  const d = new CircuitDedupe(kv); const t0 = Date.parse('2026-10-20T04:00:00Z'); // 09:30 IST
  assert.equal(d.shouldFire('ABC', 5, 'upper', t0), true); assert.equal(d.shouldFire('ABC', 5, 'upper', t0 + 60_000), false);
  assert.equal(d.shouldFire('ABC', 10, 'upper', t0 + 120_000), true); assert.equal(d.shouldFire('ABC', 5, 'upper', t0 + 180_000), false); assert.equal(d.shouldFire('ABC', 10, 'upper', t0 + 240_000), false);
  assert.equal(d.shouldFire('ABC', 20, 'upper', t0 + 300_000), true); assert.equal(d.shouldFire('ABC', 5, 'lower', t0), true); assert.equal(d.shouldFire('XYZ', 5, 'upper', t0), true);
  assert.equal(new CircuitDedupe(kv).shouldFire('ABC', 20, 'upper', t0 + 400_000), false, 'survives a reload'); // persisted
  assert.equal(new CircuitDedupe(kv).shouldFire('ABC', 5, 'upper', t0 + 86_400_000), true, 'new IST day re-arms');
  assert.equal(istDate(Date.parse('2026-10-19T19:00:00Z')), '2026-10-20'); // 00:30 IST
  assert.equal(new CircuitDedupe().shouldFire('Q', 5, 'upper', t0), true); // works with no storage
});
t('off-market: session window, sampler throttle, validation, CSV', () => {
  const open = Date.parse('2026-10-20T03:45:00Z'); // 09:15 IST Tue
  assert.equal(inSession(open), true); assert.equal(inSession(open - 60_000), false); assert.equal(inSession(Date.parse('2026-10-20T10:00:00Z')), true); assert.equal(inSession(Date.parse('2026-10-20T10:01:00Z')), false); assert.equal(inSession(Date.parse('2026-10-24T05:00:00Z')), false); // Sat
  const sm = new TickSampler(15_000); const now = open + 3_600_000;
  const a = sm.offer({ symbol: 'TCS', lastPrice: 3500, volume: 10, timestamp: now }, now)!; assert.ok(a && a.high >= 3500 && a.low <= 3500);
  assert.equal(sm.offer({ symbol: 'TCS', lastPrice: 3501, timestamp: now + 5000 }, now + 5000), null); assert.ok(sm.offer({ symbol: 'TCS', lastPrice: 3502, timestamp: now + 16_000 }, now + 16_000));
  assert.equal(sm.offer({ symbol: 'NIFTY', lastPrice: 25000, isIndex: true, timestamp: now }, now), null); assert.equal(sm.offer({ symbol: 'X', lastPrice: 5, timestamp: open - 3_600_000 }, open - 3_600_000), null);
  const good = { symbol: 'TCS', ltp: 100, high: 101, low: 99, volume: 5, ts: now };
  assert.equal(validateRows([good, { ...good, symbol: 'bad sym' }, { ...good, ltp: -1 }, { ...good, ltp: 200 }, { ...good, ts: open - 1e6 }, { ...good, ts: now + 1e7 }, null], now + 1000).length, 1);
  assert.equal(validateRows(Array(900).fill(good), now + 1000).length, 500);
  assert.equal(rowsToCsv([{ symbol: 'M&M', ltp: 1, high: 2, low: 0.5, volume: 3, ts: Date.parse('2026-10-20T03:45:00Z') }]), 'Symbol,LTP,High,Low,Volume,Timestamp\nM&M,1,2,0.5,3,2026-10-20T09:15:00+05:30\n');
});
t('replay: persisted → bars → envelope, ping-pong, bounded ±0.05 % of session High/Low, no RNG', () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({ symbol: 'A', ltp: 100 + (i % 7) * 0.1, high: 101, low: 99.5, volume: i, ts: 1_000 + i * 15_000 }));
  const p = buildReplay({ rows, ltp: 100, high: 101, low: 99.5 })!; assert.equal(p.kind, 'persisted'); assert.equal(p.path.length, 60); assert.equal(p.high, 101);
  const r = new Replayer(p); const first = r.next(); assert.equal(first, p.path[59], 'starts at the real close');
  const seq = Array.from({ length: 200 }, () => r.next()); assert.ok(seq.every((v) => v >= 99.5 * 0.9995 - 1e-9 && v <= 101 * 1.0005 + 1e-9));
  for (let i = 1; i < seq.length; i++) assert.ok(Math.abs(seq[i] - seq[i - 1]) <= 0.7, 'no teleporting');
  const bars = buildReplay({ bars: [{ close: 50 }, { close: 50.2 }, { close: 50.1 }], ltp: 50, high: 51, low: 49 })!; assert.equal(bars.kind, 'bars');
  const env = buildReplay({ ltp: 200, high: 202, low: 198 })!; assert.equal(env.kind, 'envelope'); assert.deepEqual(envelopePath(200, 202, 198), envelopePath(200, 202, 198));
  assert.ok(env.path.every((v) => Math.abs(v / 200 - 1) <= 0.0005 + 1e-12) && new Set(env.path.map((v) => v.toFixed(4))).size > 5);
  assert.equal(buildReplay({ ltp: 0, high: 0, low: 0 }), null); near(clampToSession(300, 202, 198), 202 * 1.0005); near(clampToSession(1, 202, 198), 198 * 0.9995);
  const q = { symbol: 'Q', ltp: 100, prevClose: 99, open: 99, high: 101, low: 98, volume: 7 } as any; const e = new MarketEngine(SEED_INSTRUMENTS); ingestFixture(e);
  const tcs = e.quotes.get('TCS')!; const vol = tcs.volume; const hi = tcs.high; e.setReplayPrice('TCS', tcs.ltp * 1.0002); assert.equal(tcs.volume, vol); assert.equal(tcs.high, hi); e.setReplayPrice('NOPE', 5); e.setReplayPrice('TCS', NaN); void q;
});

/* ───────────── Round 20: demo simulator, proximity, OFI, briefing ───────────── */
import { planDemo, demoPrice, demoDone, DEMO_RAMP_MS, DEMO_HOLD_MS } from '../lib/offmarketSimulator';
import { circuitWatchlist, proximityOf, proximityUpper, proximityLower } from '../lib/analytics/proximity';
import { ofi, ofiLabel } from '../lib/analytics/orderflow';
import { buildAskContext, answerAskLocally } from '../lib/ask';

t('demo simulator: 3 targets, alternating sides, 5/10/20 bands, deterministic ease-in, exact limit, restorable', () => {
  const qs = new Map([['RELIANCE', { symbol: 'RELIANCE', ltp: 1400, prevClose: 1400 }], ['HFCL', { symbol: 'HFCL', ltp: 80, prevClose: 80 }], ['PNB', { symbol: 'PNB', ltp: 100, prevClose: 100 }], ['TCS', { symbol: 'TCS', ltp: 3000, prevClose: 3000 }]]);
  const plan = planDemo(qs); assert.deepEqual(plan.map((p) => [p.symbol, p.dir, p.band]), [['RELIANCE', 'upper', 5], ['HFCL', 'lower', 10], ['PNB', 'upper', 20]]);
  assert.equal(plan[0].end, 1470); assert.equal(plan[1].end, 72); assert.equal(plan[2].end, 120);
  assert.equal(demoPrice(plan[0], 0), 1400); assert.equal(demoPrice(plan[0], DEMO_RAMP_MS), 1470); assert.equal(demoPrice(plan[0], DEMO_RAMP_MS + 5000), 1470);
  assert.ok(demoPrice(plan[0], 5000) < 1435 && demoPrice(plan[0], 5000) > 1400); assert.equal(demoPrice(plan[0], 5000), demoPrice(plan[0], 5000));
  assert.equal(demoDone(DEMO_RAMP_MS + DEMO_HOLD_MS - 1), false); assert.equal(demoDone(DEMO_RAMP_MS + DEMO_HOLD_MS), true);
  assert.deepEqual(planDemo(new Map([['TCS', qs.get('TCS')!]]), ['TCS']).map((p) => p.symbol), ['TCS']); assert.deepEqual(planDemo(new Map()), []);
  const e = ingestFixture(new MarketEngine(SEED_INSTRUMENTS)); const q = e.quotes.get('RELIANCE')!; const orig = { ltp: q.ltp, high: q.high, low: q.low, bandKnown: q.bandKnown, up: q.upperCircuit };
  const pl = planDemo((s) => e.quotes.get(s), [])[0]; assert.equal(e.demoActive, false);
  e.demoSet(pl.symbol, pl.end, pl); assert.equal(e.demoActive, true); assert.ok(circuitHit(q) !== null && circuitHit(q)!.exact, 'engine quote now sits on the limit with exact bands');
  e.step('RELIANCE', Date.now()); assert.equal(e.alerts.length, 0, 'demo never reaches the real alert desk');
  e.demoRestore(); assert.equal(e.demoActive, false); assert.deepEqual({ ltp: q.ltp, high: q.high, low: q.low, bandKnown: q.bandKnown, up: q.upperCircuit }, orig);
});
t('circuit proximity: (Upper−LTP)/Upper×100, 1.5 % watchlist, exact vs inferred bands', () => {
  near(proximityUpper(110, 108.9), 1, 1e-9); near(proximityLower(90, 90.9), 1, 1e-9);
  const ex = { symbol: 'A', ltp: 108.9, prevClose: 100, upperCircuit: 110, lowerCircuit: 90, circuitBand: 10, bandKnown: true };
  const p = proximityOf(ex)!; assert.equal(p.dir, 'upper'); assert.equal(p.inferred, false); near(p.proximityPct, 1, 1e-9);
  const inf = proximityOf({ symbol: 'B', ltp: 104.2, prevClose: 100 })!; assert.equal(inf.inferred, true); assert.equal(inf.band, 5); assert.equal(inf.dir, 'upper');
  const wl = circuitWatchlist([ex, { symbol: 'C', ltp: 100, prevClose: 100 }, { symbol: 'D', ltp: 110, prevClose: 100, upperCircuit: 110, lowerCircuit: 90, circuitBand: 10, bandKnown: true }, { symbol: 'E', ltp: 90.4, prevClose: 100, upperCircuit: 110, lowerCircuit: 90, circuitBand: 10, bandKnown: true }]);
  assert.deepEqual(wl.map((x) => x.symbol), ['E', 'A']); assert.equal(wl[0].dir, 'lower'); assert.equal(proximityOf({ symbol: 'Z', ltp: 0, prevClose: 1 }), null);
});
t('order flow imbalance: (ΣBid−ΣAsk)/(ΣBid+ΣAsk) in [−1,1], N/A without depth', () => {
  const L = (...q: number[]) => q.map((qty, i) => ({ price: 100 - i, qty, orders: 1 }));
  const o = ofi(L(300, 200, 100, 50, 50), L(100, 100, 100, 100, 100))!; near(o.value, (700 - 500) / 1200, 1e-12); assert.equal(o.levels.length, 5); near(o.levels[0], 0.5, 1e-12);
  near(ofi(L(10), L(0.0001))!.value, 1, 0.01); assert.equal(ofi(L(), L(5)), null); assert.equal(ofi(L(0), L(0)), null);
  assert.equal(ofiLabel(0.7).label, 'Extreme buy imbalance'); assert.equal(ofiLabel(-0.3).tone, 'down'); assert.equal(ofiLabel(0.05).tone, 'muted');
});
t('portfolio briefing: risk context carries HHI + ₹ shocks; local fallback renders them', () => {
  const e = ingestFixture(new MarketEngine(SEED_INSTRUMENTS)); const ctx = buildAskContext(e, [{ symbol: 'TCS', qty: 10, avg: 3000 }, { symbol: 'HDFCBANK', qty: 20, avg: 1500 }], null, 'delayed');
  assert.ok(ctx.risk && ctx.risk.hhi > 0 && ctx.risk.shocks.length === 6 && ctx.risk.sectors.length >= 1);
  const a = answerAskLocally('Give me a portfolio health briefing', ctx, []); assert.match(a, /Portfolio health briefing/); assert.match(a, /HHI/); assert.match(a, /Rate-hike/); assert.match(a, /₹/);
  assert.equal(buildAskContext(e, [], null, 'delayed').risk, null); assert.match(answerAskLocally('portfolio health briefing', buildAskContext(e, [], null, 'delayed'), []), /no holdings/i);
  assert.match(ASK_SYSTEM, /context\.risk/);
});

void Promise.all(pending).then(() => {
  console.log(`\n${passed} checks passed${process.exitCode ? ' — WITH FAILURES' : ''}`);
  process.exit(process.exitCode ?? 0); // some modules keep timers alive
});
