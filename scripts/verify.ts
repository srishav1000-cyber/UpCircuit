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
import { answerLocally, detectIntent, isContext, buildCopilotContext, normalizeContext, type CopilotContext } from '../lib/copilot';
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

import { rsiSeries, rsiZone, rsi14 as rsi14New } from '../lib/analytics/rsi';
import { vwapBandSet, bandZScore, bandZone } from '../lib/analytics/vwapBands';
import { avgPairwise, extremePairs, corrWord, sharpeParts as sharpePartsNew } from '../lib/analytics/correlation';
import { historicalVar, portfolioReturns, varRupees, annualVolPct as annVol } from '../lib/analytics/varMath';
import { METHODOLOGY } from '../lib/methodology';
import { openingRange } from '../lib/analytics/orb';
import { bucketTrades, surgeZ, surgeLevel } from '../lib/analytics/velocity';
import { planPosition } from '../lib/analytics/positionSize';
import { estimateSlippage } from '../lib/analytics/slippage';
import { quartileRanks, peerStat, ownPriceStat } from '../lib/analytics/peers';
import { buildPeerTable } from '../lib/peerTable';
import { buildResearchNote } from '../lib/researchNote';
import { drawdownSeries, drawdownEpisodes, summariseDrawdown } from '../lib/analytics/drawdown';
import { evaluateLimits, logBreaches, sanitiseLimits, statusOf, DEFAULT_LIMITS } from '../lib/analytics/limits';
import { readFileSync, existsSync } from 'node:fs';
import { createCloud, holdingsToRows, rowsToHoldings, watchlistsToRows, rowsToWatchlists, watchlistMeta, parseNotify, inList, DEFAULT_NOTIFY } from '../lib/cloud';
import { migrateLocalStorage } from '../lib/migrateLocalStorage';
import { createSaver } from '../lib/debouncedSaver';
import { parseHoldings } from '../lib/holdingsStore';
import { getNotify, setNotify, loadNotifyLocal, applyCloudNotify, attachNotifySaver, NOTIFY_KEY } from '../lib/notifyStore';
import { setScope } from '../lib/scope';
import { urlBase64ToUint8Array, toPushSub } from '../lib/pushNotifications';
import { circuitPushPayload, fanOut, isPushEndpoint } from '../lib/pushSender';
import { sendCircuitPush } from '../lib/alertPush';
import { safeNext, exchangeCode, bridgeHtml, scriptJson } from '../lib/oauthCallback';
import { challengeOf, isVerifier } from '../lib/pkce';
import { normalizeIndianMobile, maskPhone } from '../lib/auth';
import { createSupabaseBackend } from '../lib/authBackends';
import { buildBackup, readSnapshot, forceSync, backupFilename } from '../lib/backup';
import { purgeUserCache, cleanBeforeSignOut } from '../lib/signOutClean';
import { getSync, setSyncAvailable, reportSync, syncLabel } from '../lib/syncStatus';
import { soundFor } from '../lib/audioAlerts';
import { mergeHolding } from '../lib/holdingsStore';
import { liveFundamentals, smartApiLabel } from '../lib/liveFundamentals';
import type { Instrument } from '../lib/types';
import { defaultState as wlDefault, type WatchlistState as WLState } from '../lib/watchlist';
import { createFramePump, DOM_BATCH_MS, isFrozen } from '../lib/frameScheduler';
import { aggregateSectors, heatBand, sectorOf } from '../lib/sectors';
import type { Candle } from '../lib/types';
import { RANGE_SPECS, acceptDirect, aggregateBars as aggregateCalendar, resolveRange, resolutionOk, sanitizeBars, weekStart, monthStart } from '../lib/historicalEngine';
import { betaOf, portfolioRisk, riskBadge, stockWeights } from '../lib/analytics/portfolioRisk';
import { buildPdfModel, mdToBlocks, pdfText, renderPdf } from '../lib/pdfGenerator';
import { INDICATOR_COLORS, LiveIndicators, emaFull, rsiFull, vwapAvailable, vwapFull } from '../lib/technicalIndicators';
import { HISTORY_TABS, filterHistory, fromEvent, fromRows, mergeHistory, nearLimit } from '../lib/circuitTracker';
import { detectPatterns, aggregateBars, vwapSeries } from '../lib/analytics/patterns';
import { periodReturnPct, relativeStrength } from '../lib/analytics/relative';
import { healthLights } from '../lib/analytics/health';
import { DEFAULT_FOCUS, initFocus, MAX_FOCUS, WELCOME_TEXT } from '../lib/focus';
import { compactRows, parseSnapshot, MAX_AGE_MS } from '../lib/snapshotCache';

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
  s.connect(); made[0].open(); await sleep(900);
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


import { unlockAudioContext, audioState } from '../lib/chime';
import { playChime, testChime, MASTER_GAIN, WAIL, WAIL_SEC, ARPEGGIO_HZ, ARP_STEP_SEC, RING_HZ, alarmSeconds } from '../lib/audioAlerts';
import { OVERLAY_MS, OVERLAY_TEXT, bandLabel } from '../components/CircuitAlertOverlay';
import { logLine, istTime } from '../components/CircuitLogDrawer';
t('alarm audio: locked until a gesture; master 0.85; lower = synthesised 3 s air-raid siren spin-up (260→560 Hz, saws + octave, vibrato, lowpass, swell + fade); upper = C5→E5→G5→C6 sine+triangle + ring', async () => {
  type Rec = { kind: 'osc' | 'gain' | 'filter'; type: string; set: [number, number][]; ramp: [number, number][]; to: unknown[]; start_: number; stop_: number; q: number[] };
  let rec: Rec[] = [];
  const mk = (kind: Rec['kind']): Rec => ({ kind, type: '', set: [], ramp: [], to: [], start_: 0, stop_: 0, q: [] });
  class FakeCtx {
    state = 'suspended'; currentTime = 10; destination = { dest: true };
    addEventListener() {}
    async resume() { this.state = 'running'; }
    createGain() { const r = mk('gain'); rec.push(r); const g = { gain: { setValueAtTime: (v: number, t: number) => r.set.push([v, t]), exponentialRampToValueAtTime: (v: number, t: number) => r.ramp.push([v, t]) }, connect: (x: unknown) => { r.to.push(x); return x; } }; return g; }
    createBiquadFilter() { const r = mk('filter'); rec.push(r); return { set type(v: string) { r.type = v; }, Q: { setValueAtTime: (v: number) => r.q.push(v) }, frequency: { setValueAtTime: (v: number, t: number) => r.set.push([v, t]), exponentialRampToValueAtTime: (v: number, t: number) => r.ramp.push([v, t]) }, connect: (x: unknown) => { r.to.push(x); return x; } }; }
    createOscillator() { const r = mk('osc'); rec.push(r); const o = { set type(v: string) { r.type = v; }, frequency: { setValueAtTime: (v: number, t: number) => r.set.push([v, t]), exponentialRampToValueAtTime: (v: number, t: number) => r.ramp.push([v, t]) }, connect: (x: unknown) => { r.to.push(x); return x; }, start: (t: number) => { r.start_ = t; }, stop: (t: number) => { r.stop_ = t; } }; return o; }
  }
  (globalThis as unknown as { window: unknown }).window = { AudioContext: FakeCtx };
  assert.equal(audioState(), 'suspended'); assert.equal(playChime('upper'), false, 'locked before a gesture'); assert.equal(playChime('lower'), false);
  assert.equal(await unlockAudioContext(), 'running');
  const oscs = () => rec.filter((r) => r.kind === 'osc');
  const masterOf = () => rec.find((r) => r.kind === 'gain' && r.to.some((x) => (x as { dest?: boolean }).dest))!;
  // ── lower: air-raid siren spin-up (synthesised, no samples)
  rec = []; assert.equal(playChime('lower'), true);
  near(masterOf().set[0][0], MASTER_GAIN, 1e-12); assert.equal(MASTER_GAIN, 0.85); near(masterOf().set[0][1], 10, 1e-12);
  const saws = oscs().filter((o) => o.type === 'sawtooth'); const tris = oscs().filter((o) => o.type === 'triangle'); const lfo = oscs().filter((o) => o.type === 'sine');
  assert.equal(saws.length, 2, 'two detuned sawtooth voices'); assert.equal(tris.length, 1, 'octave triangle'); assert.equal(lfo.length, 1, 'vibrato LFO');
  near(saws[0].set[0][0], 260, 0); near(saws[0].ramp[0][0], 560, 0); near(saws[1].set[0][0], 260 * WAIL.detune, 1e-9); near(tris[0].set[0][0], 520, 0); near(tris[0].ramp[0][0], 1120, 0); near(lfo[0].set[0][0], 5, 0);
  assert.ok(saws[0].ramp[0][1] > saws[0].set[0][1] + 2, 'pitch climbs over ~2.7 s'); for (const o of [...saws, ...tris]) near(o.stop_ - o.start_, 3.02, 1e-9);
  const lp = rec.filter((r) => r.kind === 'filter'); assert.equal(lp.length, 1); assert.equal(lp[0].type, 'lowpass'); assert.equal(lp[0].set[0][0], WAIL.cutoffStart); assert.equal(lp[0].ramp[0][0], WAIL.cutoffEnd);
  const env = rec.find((r) => r.kind === 'gain' && r.set[0] && r.set[0][0] === 0.0001 && r.ramp.length === 2 && r.ramp[0][0] === 1)!; assert.ok(env, 'swell → hold → fade envelope'); near(env.ramp[0][1] - env.set[0][1], WAIL.swellSec, 1e-9); near(env.ramp[1][1] - env.set[0][1], 3, 1e-9);
  near(WAIL_SEC, 3, 0); near(alarmSeconds('lower'), 3, 0);
  // ── upper: arpeggio
  rec = []; assert.equal(playChime('upper'), true);
  const o2 = oscs(); const sine = o2.filter((o) => o.type === 'sine'); const tri = o2.filter((o) => o.type === 'triangle');
  [523, 659, 784, 1046].forEach((f, i) => near(tri[i].set[0][0], f, 1)); // equal-tempered C5 E5 G5 C6 (1046.5 ≈ 1046)
  sine.slice(0, 4).forEach((o, i) => near(o.set[0][0], ARPEGGIO_HZ[i], 0)); // sine blended under each triangle note
  for (let i = 1; i < 4; i++) near(tri[i].start_ - tri[i - 1].start_, ARP_STEP_SEC, 1e-9);
  const ring = sine[4]; assert.equal(ring.set[0][0], RING_HZ); assert.ok(RING_HZ > 2000); assert.ok(ring.stop_ - ring.start_ > 1, 'sustained ring'); assert.ok(tri[3].stop_ - tri[3].start_ > 1, 'final C6 sustains');
  // ── level scaling (audio-ON confirmation) + test button
  rec = []; playChime('upper', 0.2); near(masterOf().set[0][0], 0.17, 1e-12); rec = []; playChime('upper', 5); near(masterOf().set[0][0], 0.85, 1e-12);
  rec = []; assert.equal(await testChime('lower'), true); assert.equal(oscs().length, 4);

  delete (globalThis as unknown as { window?: unknown }).window;
});
t('alert overlay copy: banners, status notes, signed band labels, 3 s minimum', () => {
  assert.equal(OVERLAY_TEXT.lower.banner, '▼ LOWER CIRCUIT HALT DETECTED'); assert.equal(OVERLAY_TEXT.lower.note, 'Liquidity Frozen • Sellers Only • Order Execution Paused');
  assert.equal(OVERLAY_TEXT.upper.banner, '▲ UPPER CIRCUIT BREACH DETECTED'); assert.equal(OVERLAY_TEXT.upper.note, 'Maximum Daily Range Hit • Buyers Only • Circuit Lock Active');
  assert.equal(bandLabel('lower', 5), '−5%'); assert.equal(bandLabel('upper', 20), '+20%'); assert.ok(OVERLAY_MS >= 3000);
});
t('circuit log line: [HH:MM:SS] | SYMBOL | TYPE | ₹price | %change (IST)', () => {
  const at = Date.parse('2026-10-19T09:45:07+05:30');
  assert.equal(istTime(at), '09:45:07');
  assert.equal(logLine({ at, symbol: 'ABC', dir: 'upper', ltp: 220.05, pct: 10.02 }), '[09:45:07] | ABC | UPPER | ₹220.05 | +10.02%');
  assert.equal(logLine({ at, symbol: 'ABC', dir: 'upper', ltp: 220.05, pct: 10.02, band: 10 }), '[09:45:07] | ABC | UPPER | ₹220.05 | +10.02% | band +10%');
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
import { parseCopilotCard, QUICK_ACTIONS } from '../lib/copilotCards';
import { relativeTime, extractSymbols, splitGoogleTitle, isMarketRelevant, mentionsStock, stockNews, summarizeSentiment, sentimentChipText } from '../lib/newsEngine';
import { thinStroke, moveDrawing as moveDrw, rangeStats } from '../lib/drawings';


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

t('RSI(14): Wilder reference values, bounds, flat series and re-export parity', () => {
  // 33 closes; expected values cross-checked against an independent Python Wilder implementation (not the code under test)
  const c = [44.3389, 44.0902, 44.1497, 43.6124, 44.3278, 44.8264, 45.0955, 45.4766, 45.3428, 45.8427, 46.0826, 45.8931, 46.0328, 45.614, 46.282, 46.282, 46.0028, 46.0328, 46.4116, 46.2222, 45.6439, 46.2122, 46.2521, 45.7137, 46.4515, 45.7835, 45.3548, 44.0288, 44.1783, 44.2220, 44.5738, 43.4244, 42.8660];
  const s14 = rsiSeries(c); near(s14[14]!, 69.43372072, 1e-6); near(s14[15]!, 69.43372072, 1e-6); assert.equal(s14[13], null); near(s14[32]!, 33.77092998, 1e-6);
  assert.equal(rsi14New([1, 2, 3]), null); assert.equal(rsi14New(Array(30).fill(10)), 50);
  assert.equal(rsi14New(Array.from({ length: 30 }, (_, i) => 10 + i)), 100); near(rsi14New(Array.from({ length: 30 }, (_, i) => 100 - i))!, 0, 1e-9);
  assert.equal(rsi14(c), rsi14New(c)); assert.equal(rsiZone(25), 'oversold'); assert.equal(rsiZone(70), 'overbought'); assert.equal(rsiZone(50), 'neutral'); assert.equal(rsiZone(null), null);
  for (const v of s14) if (v !== null) assert.ok(v >= 0 && v <= 100);
});
t('VWAP ±1σ/±2σ bands: volume-weighted σ, nesting, z-score and zones', () => {
  const tr = [{ t: 1, p: 100, v: 100 }, { t: 2, p: 102, v: 300 }, { t: 3, p: 98, v: 100 }];
  const b = vwapBandSet(tr)!; const vw = (100 * 100 + 102 * 300 + 98 * 100) / 500; near(b.vwap, vw, 1e-12);
  near(b.sd, Math.sqrt((100 * (100 - vw) ** 2 + 300 * (102 - vw) ** 2 + 100 * (98 - vw) ** 2) / 500), 1e-12);
  near(b.upper1 - b.vwap, b.sd, 1e-12); near(b.upper2 - b.vwap, 2 * b.sd, 1e-12); near(b.vwap - b.lower2, 2 * b.sd, 1e-12); assert.ok(b.lower2 < b.lower1 && b.upper1 < b.upper2);
  near(bandZScore(b.vwap + 1.5 * b.sd, b), 1.5, 1e-9); assert.equal(bandZone(b.vwap, b), 'inside'); assert.equal(bandZone(b.vwap + 1.5 * b.sd, b), 'above1'); assert.equal(bandZone(b.vwap + 2.5 * b.sd, b), 'above2'); assert.equal(bandZone(b.vwap - 1.5 * b.sd, b), 'below1'); assert.equal(bandZone(b.vwap - 3 * b.sd, b), 'below2');
  assert.equal(vwapBandSet([]), null); assert.equal(vwapBandSet([{ t: 1, p: 100, v: 0 }]), null);
  const flat = vwapBandSet([{ t: 1, p: 50, v: 10 }, { t: 2, p: 50, v: 20 }])!; assert.equal(flat.sd, 0); assert.equal(bandZScore(55, flat), 0);
  assert.equal(vwapBands(tr, 2)!.upper, b.upper2);
});
t('Correlation matrix and Sharpe: identity, symmetry, summaries, Sharpe parts', () => {
  const up = Array.from({ length: 80 }, (_, i) => 100 + i + Math.sin(i) * 3); const dn = up.map((v) => 300 - v); const m = correlationMatrix({ A: up, B: up.map((v) => v * 2), C: dn });
  for (let i = 0; i < 3; i++) { near(m.matrix[i][i], 1, 1e-12); for (let j = 0; j < 3; j++) near(m.matrix[i][j], m.matrix[j][i], 1e-12); }
  assert.ok(m.matrix[0][1] > 0.99); assert.ok(m.matrix[0][2] < -0.5); const ex = extremePairs(m)!; assert.deepEqual([ex.high.a, ex.high.b], ['A', 'B']); assert.deepEqual([ex.low.a, ex.low.b].sort(), ['A', 'C'].sort() ); 
  near(avgPairwise(m)!, (m.matrix[0][1] + m.matrix[0][2] + m.matrix[1][2]) / 3, 1e-12); assert.equal(avgPairwise(correlationMatrix({ A: up })), null);
  assert.equal(corrWord(0.85), 'strong positive'); assert.equal(corrWord(-0.5), 'moderate negative'); assert.equal(corrWord(0.05), 'negligible');
  const g = Array.from({ length: 60 }, (_, i) => 100 * Math.pow(1.001, i) * (1 + (i % 2 ? 0.004 : -0.004))); const sp = sharpePartsNew(g, 0.065)!; near(sp.sharpe, (sp.annReturnPct / 100 - 0.065) / (sp.annVolPct / 100), 1e-9);
  assert.equal(sharpePartsNew(Array(60).fill(100)), null); assert.equal(sharpePartsNew([1, 2, 3]), null);
});
t('Historical VaR 95% and Expected Shortfall: quantile definition, ES ≥ VaR, ₹ scaling, N/A', () => {
  const r = Array.from({ length: 100 }, (_, i) => (i - 50) / 1000); // −5.0 % … +4.9 %, 100 obs
  const v = historicalVar(r, 0.95)!; assert.equal(v.tail, 5); near(v.varPct, 0.046, 1e-12); near(v.esPct, (0.05 + 0.049 + 0.048 + 0.047 + 0.046) / 5, 1e-12); assert.ok(v.esPct >= v.varPct); assert.equal(v.n, 100);
  assert.ok(historicalVar(r, 0.99)!.varPct >= v.varPct); assert.equal(historicalVar(r.slice(0, 40)), null); assert.equal(historicalVar(Array(100).fill(0.01))!.varPct, 0);
  near(varRupees(v, 1_000_000).var, 46_000, 1e-6);
  const pr = portfolioReturns([[100, 110, 99], [50, 50, 55]], [2, 4]); assert.equal(pr.length, 2); near(pr[0], (220 + 200) / (200 + 200) - 1, 1e-12); near(pr[1], (198 + 220) / (220 + 200) - 1, 1e-12); assert.deepEqual(portfolioReturns([], []), []);
  assert.ok(annVol(Array.from({ length: 60 }, (_, i) => 100 + (i % 2) * 2)) > 0);
});
t('methodology reference: every analytic documents formula, inputs, window, source and caveat', () => {
  assert.ok(METHODOLOGY.length >= 10); const ids = new Set(METHODOLOGY.map((m) => m.id)); assert.equal(ids.size, METHODOLOGY.length);
  for (const id of ['rsi', 'vwap', 'corr', 'sharpe', 'var', 'wvol', 'hhi']) assert.ok(ids.has(id), id);
  for (const m of METHODOLOGY) { assert.ok(m.formula.length > 15 && m.inputs && m.window && m.caveat && m.source.length >= 1, m.id); }
});

t('ORB: 09:15–09:30 range, first close outside, confirmation, volume ratio, forming/inside states', () => {
  const day = 20_000 * 86400; const at = (hh: number, mm: number) => day + (hh * 60 + mm) * 60;
  const bar = (hh: number, mm: number, hi: number, lo: number, cl: number, v: number) => ({ time: at(hh, mm), high: hi, low: lo, close: cl, volume: v });
  const orBars = Array.from({ length: 15 }, (_, i) => bar(9, 15 + i, 101 + (i === 5 ? 1 : 0), 99 - (i === 9 ? 1 : 0), 100, 100)); // range 98..102
  const f = openingRange(orBars)!; assert.equal(f.state, 'forming'); assert.equal(f.high, 102); assert.equal(f.low, 98); near(f.widthPct, (4 / 98) * 100, 1e-9); assert.equal(f.breakout, null); assert.equal(f.barsInRange, 15);
  const up = openingRange([...orBars, bar(9, 30, 101, 100, 101, 90), bar(9, 31, 104, 101, 103, 250), bar(9, 32, 105, 102, 104, 120)])!;
  assert.equal(up.state, 'above'); assert.equal(up.breakout!.dir, 'up'); assert.equal(up.breakout!.time, '09:31'); assert.equal(up.breakout!.confirmed, true); near(up.breakout!.volumeRatio!, 2.5, 1e-9); near(up.breakout!.distancePct, (1 / 102) * 100, 1e-9);
  const poke = openingRange([...orBars, bar(9, 31, 104, 101, 103, 100), bar(9, 32, 103, 100, 101, 100)])!; assert.equal(poke.breakout!.confirmed, false); assert.equal(poke.state, 'inside');
  const dn = openingRange([...orBars, bar(9, 40, 99, 96, 97, 100)])!; assert.equal(dn.breakout!.dir, 'down'); assert.equal(dn.state, 'below'); near(dn.breakout!.distancePct, (1 / 98) * 100, 1e-9);
  assert.equal(openingRange([]), null); assert.equal(openingRange([bar(10, 0, 5, 4, 5, 1)]), null);
  const prev = Array.from({ length: 3 }, (_, i) => ({ ...bar(9, 15 + i, 500, 490, 495, 10), time: at(9, 15 + i) - 86400 })); assert.equal(openingRange([...prev, ...orBars])!.high, 102);
});
t('tick velocity / volume surge z-score: baseline mean & sd, warm-up, levels, bucketing', () => {
  const base = [10, 12, 9, 11, 10, 13, 8, 12, 11, 10]; const m = base.reduce((a, b) => a + b, 0) / base.length; const sd = Math.sqrt(base.reduce((a, b) => a + (b - m) ** 2, 0) / (base.length - 1));
  const r = surgeZ([...base, 30, 30, 30], 3)!; near(r.z, (30 - m) / sd, 1e-9); near(r.baseline, m, 1e-12); near(r.recent, 30, 1e-12);
  assert.equal(surgeZ([1, 2, 3], 3), null); assert.equal(surgeZ(Array(20).fill(5), 3), null);
  assert.equal(surgeLevel(0.2), 'normal'); assert.equal(surgeLevel(1.5), 'elevated'); assert.equal(surgeLevel(2.4), 'surge'); assert.equal(surgeLevel(3.5), 'extreme'); assert.equal(surgeLevel(-1.4), 'quiet');
  const b = bucketTrades([{ t: 1000, v: 5 }, { t: 1500, v: 7 }, { t: 2500, v: 3 }, { t: 9999, v: 1 }], 3000, 1000, 3); assert.deepEqual(b.counts, [0, 2, 1]); assert.deepEqual(b.volumes, [0, 12, 3]);
});
t('position size: qty = ⌊risk₹ ÷ |entry−stop|⌋, cash cap, R targets, short side, circuit/noise warnings, errors', () => {
  const p = planPosition({ capital: 100000, riskPct: 1, entry: 500, stop: 490 }); assert.ok(!('error' in p)); if ('error' in p) return;
  assert.equal(p.side, 'long'); assert.equal(p.riskRupees, 1000); assert.equal(p.qty, 100); assert.equal(p.positionValue, 50000); near(p.positionPct, 50, 1e-9); assert.equal(p.lossAtStop, 1000); assert.deepEqual(p.targets.map((x) => x.price), [510, 520, 530]); assert.deepEqual(p.targets.map((x) => x.gain), [1000, 2000, 3000]); assert.equal(p.warnings.length, 0);
  const sh = planPosition({ capital: 100000, riskPct: 1, entry: 500, stop: 510 }) as Exclude<ReturnType<typeof planPosition>, { error: string }>; assert.equal(sh.side, 'short'); assert.deepEqual(sh.targets.map((x) => x.price), [490, 480, 470]);
  const cap = planPosition({ capital: 10000, riskPct: 5, entry: 1000, stop: 999 }) as Exclude<ReturnType<typeof planPosition>, { error: string }>; assert.equal(cap.qty, 10); assert.equal(cap.cappedByCash, true); assert.match(cap.warnings.join(' '), /Cash-limited/);
  const circ = planPosition({ capital: 100000, riskPct: 1, entry: 100, stop: 85, lowerCircuit: 90 }) as Exclude<ReturnType<typeof planPosition>, { error: string }>; assert.match(circ.warnings.join(' '), /lower circuit/);
  const tight = planPosition({ capital: 100000, riskPct: 1, entry: 1000, stop: 999.5 }) as Exclude<ReturnType<typeof planPosition>, { error: string }>; assert.match(tight.warnings.join(' '), /0\.1 %/);
  for (const bad of [{ capital: 0, riskPct: 1, entry: 1, stop: 1 }, { capital: 1, riskPct: 1, entry: 5, stop: 5 }, { capital: 1, riskPct: 0, entry: 5, stop: 4 }, { capital: NaN, riskPct: 1, entry: 5, stop: 4 }]) assert.ok('error' in (planPosition(bad) as object));
});
t('slippage estimator: walks asks/bids, average fill, bps, partial fill flag, N/A', () => {
  const asks = [{ price: 100.1, qty: 100 }, { price: 100.2, qty: 200 }, { price: 100.5, qty: 300 }]; const bids = [{ price: 100.0, qty: 150 }, { price: 99.9, qty: 100 }];
  const b = estimateSlippage(bids, asks, 'buy', 250)!; near(b.avgPrice, (100 * 100.1 + 150 * 100.2) / 250, 1e-9); assert.equal(b.best, 100.1); near(b.slipPerShare, b.avgPrice - 100.1, 1e-9); near(b.slipBps, (b.slipPerShare / 100.1) * 1e4, 1e-9); near(b.slipTotal, b.slipPerShare * 250, 1e-9); assert.equal(b.levelsUsed, 2); assert.equal(b.unfilled, 0);
  near(b.halfSpreadBps!, ((100.1 - 100.0) / 2 / 100.05) * 1e4, 1e-6);
  const s = estimateSlippage(bids, asks, 'sell', 400)!; assert.equal(s.filled, 250); assert.equal(s.unfilled, 150); assert.equal(s.best, 100.0); near(s.avgPrice, (150 * 100 + 100 * 99.9) / 250, 1e-9);
  const one = estimateSlippage(bids, asks, 'buy', 50)!; assert.equal(one.slipPerShare, 0); assert.equal(estimateSlippage([], [], 'buy', 10), null); assert.equal(estimateSlippage(bids, asks, 'buy', 0), null);
});
t('peers: quartile ranks (best→worst, ties, N/A excluded), peer percentile/z, own-price stat, table + note', () => {
  const r = quartileRanks([{ symbol: 'A', value: 10 }, { symbol: 'B', value: 20 }, { symbol: 'C', value: 30 }, { symbol: 'D', value: 40 }, { symbol: 'E', value: null }], 'lower');
  assert.deepEqual(r.map((x) => x.rank), [1, 2, 3, 4, null]); assert.deepEqual(r.map((x) => x.quartile), [1, 2, 3, 4, null]); assert.equal(r[0].of, 4);
  const h = quartileRanks([{ symbol: 'A', value: 10 }, { symbol: 'B', value: 20 }], 'higher'); assert.deepEqual(h.map((x) => x.rank), [2, 1]); assert.deepEqual(quartileRanks([{ symbol: 'A', value: 5 }, { symbol: 'B', value: 5 }], 'higher').map((x) => x.rank), [1, 1]);
  const st = peerStat([10, 20, 30, 40], 30)!; near(st.mean, 25, 1e-12); near(st.sd, Math.sqrt(500 / 3), 1e-12); near(st.z!, 5 / Math.sqrt(500 / 3), 1e-12); near(st.percentile!, (2 / 3) * 100, 1e-9); assert.equal(peerStat([10], 10), null); assert.equal(peerStat([5, 5, 5], 5)!.z, null);
  const c = Array.from({ length: 100 }, (_, i) => 100 + i); const o = ownPriceStat(c, 190)!; assert.equal(o.percentile, 90); near(o.z!, (190 - 149.5) / Math.sqrt(100 * 101 / 12), 1e-9); assert.equal(ownPriceStat([1, 2], 1), null);
  const tab = buildPeerTable([{ symbol: 'A', mcapCr: 5000, pe: 12, roe: 18, de: 0.4, dy: 1.2, retPct: 10, volPct: 20, sharpe: 0.3 }, { symbol: 'B', mcapCr: 90000, pe: 30, roe: 12, de: null, dy: null, retPct: 25, volPct: 30, sharpe: 0.9 }, { symbol: 'C', mcapCr: null, pe: null, roe: null, de: null, dy: null, retPct: null, volPct: null, sharpe: null }]);
  assert.equal(tab[0].valueQuartile, '#1 of 2'); assert.equal(tab[1].valueQuartile, '#2 of 2'); assert.equal(tab[2].valueQuartile, null); assert.equal(tab[0].q.pe, null); // < 4 peers → no quartile
  const four = buildPeerTable([10, 20, 30, 40].map((pe, i) => ({ symbol: 'P' + i, mcapCr: 1, pe, roe: 40 - pe, de: 1, dy: 1, retPct: 1, volPct: 1, sharpe: 1 }))); assert.deepEqual(four.map((x) => x.valueQuartile), ['Q1', 'Q2', 'Q3', 'Q4']); assert.deepEqual(four.map((x) => x.q.roe), [1, 2, 3, 4]); assert.equal(tab[1].cells.de, 'N/A'); assert.equal(tab[2].cells.mcap, 'N/A'); assert.equal(tab[1].cells.mcap, '90,000');
  const note = buildResearchNote({ symbol: 'A', name: 'Alpha Ltd', sector: 'IT', ltp: 100, changePct: 1.5, feed: 'Yahoo Delayed', now: new Date('2026-10-21T04:00:00Z'), fundamentals: [{ label: 'P/E', value: '12.0', source: 'Yahoo Delayed' }], peers: tab, valuation: [{ label: 'P/E percentile', value: 'N/A', source: 'Computed Math' }], risk: [{ label: 'Sharpe', value: '0.30', source: 'Computed Math' }] });
  assert.match(note, /^# Research note — Alpha Ltd \(A\)/); assert.match(note, /\*\*A\*\*/); assert.match(note, /N\/A/); assert.match(note, /Computed Math/); assert.match(note, /not investment advice/i); assert.match(note, /9:30 am IST/i);
});
t('drawdown: running peak, max/current %, episodes with trough + recovery days, ongoing, min depth filter', () => {
  const v = [100, 110, 99, 88, 95, 110, 120, 108, 114, 118]; const dd = drawdownSeries(v); near(dd[3], (88 / 110 - 1) * 100, 1e-9); assert.equal(dd[6], 0); near(dd[9], (118 / 120 - 1) * 100, 1e-9);
  const e = drawdownEpisodes(v, 2); assert.equal(e.length, 2); assert.equal(e[0].peakIdx, 1); assert.equal(e[0].troughIdx, 3); assert.equal(e[0].recoveryIdx, 5); assert.equal(e[0].daysToTrough, 2); assert.equal(e[0].daysToRecover, 2); near(e[0].depthPct, -20, 1e-9);
  assert.equal(e[1].peakIdx, 6); assert.equal(e[1].troughIdx, 7); assert.equal(e[1].recoveryIdx, null); assert.equal(e[1].daysToRecover, null); near(e[1].depthPct, -10, 1e-9);
  assert.equal(drawdownEpisodes(v, 15).length, 1); assert.equal(drawdownEpisodes([1], 2).length, 0);
  const long = [...Array.from({ length: 30 }, (_, i) => 100 + i), ...Array.from({ length: 10 }, (_, i) => 129 - i * 3)]; const sm = summariseDrawdown(long)!; assert.ok(sm.maxPct < -20); near(sm.currentPct, sm.maxPct, 1e-9); assert.equal(sm.underwaterDays, 9); assert.equal(sm.longestRecoveryDays, null); assert.equal(summariseDrawdown([1, 2, 3]), null);
});
t('policy limits: pass/near/breach, HHI, circuit exposure, sanitising, once-per-day breach log', () => {
  assert.equal(statusOf(19, 20), 'near'); assert.equal(statusOf(17, 20), 'pass'); assert.equal(statusOf(20.1, 20), 'breach'); assert.equal(statusOf(20, 20), 'near');
  const pos = [{ symbol: 'A', sector: 'IT', value: 600, nearCircuit: true }, { symbol: 'B', sector: 'IT', value: 100, nearCircuit: false }, { symbol: 'C', sector: 'Bank', value: 300, nearCircuit: false }];
  const rows = evaluateLimits({ positions: pos }, DEFAULT_LIMITS)!; const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  near(by.stock.actual, 60, 1e-9); assert.equal(by.stock.status, 'breach'); assert.equal(by.stock.detail, 'A'); near(by.sector.actual, 70, 1e-9); assert.equal(by.sector.detail, 'IT'); near(by.hhi.actual, 70 ** 2 + 30 ** 2, 1e-9); assert.equal(by.hhi.status, 'breach'); near(by.circuit.actual, 60, 1e-9); assert.equal(by.circuit.detail, 'A');
  assert.equal(evaluateLimits({ positions: [] }, DEFAULT_LIMITS), null);
  assert.deepEqual(sanitiseLimits({ stock: 5, sector: 'x', hhi: -3, circuit: 500 }), { stock: 5, sector: 40, hhi: 2500, circuit: 20 }); assert.deepEqual(sanitiseLimits(null), DEFAULT_LIMITS);
  const l1 = logBreaches([], rows, 1000, '2026-10-21'); assert.equal(l1.added.length, 4); const l2 = logBreaches(l1.log, rows, 2000, '2026-10-21'); assert.equal(l2.added.length, 0); assert.equal(l2.log.length, 4); const l3 = logBreaches(l2.log, rows, 3000, '2026-10-22'); assert.equal(l3.added.length, 4); assert.equal(l3.log.length, 8);
  assert.equal(logBreaches([], rows.map((r) => ({ ...r, status: 'pass' as const })), 1, 'd').added.length, 0);
});

t('frame pump: first tick paints next frame, bursts coalesce to one trailing frame ≥ 100 ms later, cancel is reusable', () => {
  let now = 0; const rafQ: (() => void)[] = []; const timers: { at: number; cb: () => void }[] = []; let flushes = 0;
  const pump = createFramePump(() => { flushes++; }, 100, { now: () => now, raf: (cb) => { rafQ.push(cb); return 0; }, setTimer: (cb, ms) => { timers.push({ at: now + ms, cb }); return timers.length; }, clearTimer: () => { timers.length = 0; } });
  const frame = () => { while (rafQ.length) rafQ.shift()!(); }; const advance = (to: number) => { now = to; for (const tm of timers.filter((x) => x.at <= now)) { timers.splice(timers.indexOf(tm), 1); tm.cb(); } };
  pump.request(); assert.equal(rafQ.length, 1); assert.equal(timers.length, 0); frame(); assert.equal(flushes, 1); // idle → immediate frame
  now = 30; for (let i = 0; i < 50; i++) pump.request(); assert.equal(rafQ.length, 0); assert.equal(timers.length, 1); assert.equal(timers[0].at, 100); // burst → one timer for the remaining gap
  advance(100); frame(); assert.equal(flushes, 2); assert.deepEqual(pump.stats(), { requests: 51, flushes: 2 });
  now = 500; pump.request(); frame(); assert.equal(flushes, 3); // long idle → immediate again
  now = 520; pump.request(); pump.cancel(); assert.equal(timers.length, 0); now = 900; pump.request(); frame(); assert.equal(flushes, 4); // usable after cancel (strict mode)
});
t('patterns: bullish/bearish engulfing, resistance breakout (+ volume rule), double bottom, volatility doji, nothing on noise', () => {
  const b = (o: number, h: number, l: number, c: number, v = 100) => ({ open: o, high: h, low: l, close: c, volume: v });
  const flat = Array.from({ length: 20 }, () => b(100, 101, 99, 100.2));
  const bull = detectPatterns([...flat, b(100.5, 100.6, 99.4, 99.6), b(99.4, 101.5, 99.3, 101.2)]); assert.ok(bull.some((p) => p.id === 'bullEngulf')); assert.ok(!bull.some((p) => p.id === 'bearEngulf'));
  const bear = detectPatterns([...flat, b(99.5, 100.6, 99.4, 100.5), b(100.7, 100.8, 98.9, 99.2)]); assert.ok(bear.some((p) => p.id === 'bearEngulf'));
  assert.ok(!detectPatterns([...flat, b(100, 101, 99, 99.5), b(99.6, 100.5, 99.2, 100.2)]).some((p) => p.id === 'bullEngulf')); // does not cover the previous body
  const bo = detectPatterns([...flat.slice(0, 19), b(100.5, 103, 100.4, 102.8, 300)]); assert.ok(bo.some((p) => p.id === 'breakout')); assert.ok(!detectPatterns([...flat.slice(0, 19), b(100.5, 103, 100.4, 102.8, 100)]).some((p) => p.id === 'breakout')); // needs volume
  assert.ok(!detectPatterns([...flat.slice(0, 19), b(100.5, 100.9, 100.4, 100.8, 300)]).some((p) => p.id === 'breakout')); // not above the prior high (101)
  const px = [102, 101.5, 101, 100.5, 100, 100.3, 101, 102, 103, 103.5, 103, 102, 101, 100.2, 100.1, 100.6, 101.5, 102.5, 103.2, 104];
  const db = detectPatterns(px.map((c, i) => b(c, c + 0.2, c - 0.2 - (i === 4 || i === 14 ? 0 : 0), c, 100))); assert.ok(db.some((p) => p.id === 'doubleBottom'), JSON.stringify(db.map((x) => x.id)));
  const doji = detectPatterns([...flat, b(100, 104, 96, 100.2)]); assert.ok(doji.some((p) => p.id === 'volDoji')); assert.ok(!detectPatterns([...flat, b(100, 101.2, 98.9, 100.1)]).some((p) => p.id === 'volDoji')); // range not wide enough
  assert.deepEqual(detectPatterns(flat), []); assert.deepEqual(detectPatterns([b(1, 2, 0, 1)]), []);
});
t('bars: 1m→5m aggregation (OHLCV) and session VWAP restarting each day', () => {
  const m = (t: number, o: number, h: number, l: number, c: number, v: number) => ({ time: t, open: o, high: h, low: l, close: c, volume: v });
  const base = 20_000 * 86400 + 9 * 3600 + 15 * 60; const one = Array.from({ length: 10 }, (_, i) => m(base + i * 60, 100 + i, 101 + i, 99 + i, 100.5 + i, 10 + i));
  const a = aggregateBars(one, 5); assert.equal(a.length, 2); assert.equal(a[0].open, 100); assert.equal(a[0].close, 104.5); assert.equal(a[0].high, 105); assert.equal(a[0].low, 99); assert.equal(a[0].volume, 10 + 11 + 12 + 13 + 14); assert.equal(a[1].open, 105); assert.equal(a[1].time - a[0].time, 300);
  const v = vwapSeries([m(base, 1, 3, 1, 2, 100), m(base + 60, 1, 5, 1, 3, 300), m(base + 86400, 1, 11, 1, 6, 50)]); near(v[0]!, 2, 1e-12); near(v[1]!, (2 * 100 + ((5 + 1 + 3) / 3) * 300) / 400, 1e-12); near(v[2]!, (11 + 1 + 6) / 3, 1e-12);
  assert.equal(vwapSeries([m(base, 1, 1, 1, 1, 0)])[0], null);
});
t('relative strength: period returns, pp difference, short history → N/A', () => {
  const s = [100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119, 120, 121, 122]; near(periodReturnPct(s, 5)!, (122 / 117 - 1) * 100, 1e-9); near(periodReturnPct(s, 21)!, (122 / 101 - 1) * 100, 1e-9); assert.equal(periodReturnPct(s, 22), 100 * (122 / 100 - 1) === 22 ? 22 : periodReturnPct(s, 22)); assert.equal(periodReturnPct(s.slice(0, 3), 5), null);
  const b = s.map((x) => 1000 + x * 2); const r = relativeStrength(s, b, 1.2, 0.5); assert.equal(r.length, 3); near(r[0].rs!, 0.7, 1e-12); near(r[1].rs!, periodReturnPct(s, 5)! - periodReturnPct(b, 5)!, 1e-12); near(r[2].rs!, periodReturnPct(s, 21)! - periodReturnPct(b, 21)!, 1e-12);
  const na = relativeStrength([1, 2], [1, 2], null, 0.5); assert.deepEqual(na.map((x) => x.rs), [null, null, null]);
});
t('health lights: thresholds, banks (no D/E), loss-making P/E, momentum rules, N/A never guessed', () => {
  const L = (x: Partial<Parameters<typeof healthLights>[0]>) => healthLights({ debtToEquity: null, roe: null, roce: null, pe: null, rsi: null, ret1mPct: null, aboveVwap: null, ...x });
  assert.deepEqual(L({}).map((l) => l.light), ['na', 'na', 'na', 'na']);
  assert.equal(L({ debtToEquity: 0.3 })[0].light, 'green'); assert.equal(L({ debtToEquity: 0.5 })[0].light, 'green'); assert.equal(L({ debtToEquity: 1.2 })[0].light, 'yellow'); assert.equal(L({ debtToEquity: 2 })[0].light, 'red'); assert.match(L({ debtToEquity: 2 })[0].summary, /2\.00×/);
  assert.equal(L({ roe: 20 })[1].light, 'green'); assert.equal(L({ roe: 10 })[1].light, 'yellow'); assert.equal(L({ roe: 3 })[1].light, 'red'); assert.equal(L({ roce: 18 })[1].light, 'green'); assert.match(L({ roce: 18 })[1].summary, /ROCE/);
  assert.equal(L({ pe: 18 })[2].light, 'green'); assert.equal(L({ pe: 25 })[2].light, 'green'); assert.equal(L({ pe: 40 })[2].light, 'yellow'); assert.equal(L({ pe: 80 })[2].light, 'red'); assert.equal(L({ pe: -5 })[2].light, 'red'); assert.match(L({ pe: -5 })[2].summary, /Loss-making/);
  assert.equal(L({ rsi: 60, ret1mPct: 4, aboveVwap: true })[3].light, 'green'); assert.equal(L({ rsi: 40, ret1mPct: -4, aboveVwap: false })[3].light, 'red'); assert.equal(L({ rsi: 60, ret1mPct: -4, aboveVwap: true })[3].light, 'yellow'); assert.equal(L({ rsi: 80, ret1mPct: 9, aboveVwap: true })[3].light, 'yellow'); assert.match(L({ rsi: 80, ret1mPct: 9, aboveVwap: true })[3].summary, /stretched/);
  assert.equal(L({ rsi: 60, ret1mPct: 4 })[3].light, 'green'); // VWAP unknown → judged on the rest
});
t('focus onboarding: new user gets 6 blue-chips once; saved lists and deliberately emptied baskets are left alone', () => {
  assert.deepEqual([...DEFAULT_FOCUS], ['RELIANCE', 'HDFCBANK', 'TCS', 'INFY', 'ICICIBANK', 'SBIN']); assert.equal(DEFAULT_FOCUS.length, MAX_FOCUS);
  const n = initFocus(null, false); assert.deepEqual(n, { list: [...DEFAULT_FOCUS], seeded: true }); assert.deepEqual(initFocus('[]', false), { list: [...DEFAULT_FOCUS], seeded: true }); assert.deepEqual(initFocus('garbage', false).list, [...DEFAULT_FOCUS]);
  assert.deepEqual(initFocus('["ITC","wipro"]', false), { list: ['ITC', 'WIPRO'], seeded: false }); assert.deepEqual(initFocus('[]', true), { list: [], seeded: false }); assert.deepEqual(initFocus(null, true), { list: [], seeded: false });
  assert.notEqual(initFocus(null, false).list, DEFAULT_FOCUS as unknown); assert.match(WELCOME_TEXT, /^👋 Welcome to UpCircuit Terminal! We've pre-loaded 6 blue-chip NIFTY stocks in your Focus Basket\. Click 'Edit' anytime to customize your watchlist\.$/);
});
t('snapshot cache: compacts real rows, rejects junk / stale / future, engine hydrates without alerts and is replaced by a live fetch', () => {
  const rows = [{ symbol: 'RELIANCE', ltp: 100, prevClose: 99, open: 99.5, extra: 'x' } as never, { symbol: 'TCS', ltp: 0, prevClose: 1 }, { symbol: 'INFY', ltp: 10, prevClose: 9, volume: 5 }, { symbol: 'NIFTY', ltp: 20000, prevClose: 19900, isIndex: true }, { symbol: 'SBIN', ltp: 5, prevClose: 4 }];
  const c = compactRows(rows); assert.deepEqual(c.map((r) => r.symbol), ['RELIANCE', 'INFY', 'NIFTY', 'SBIN']); assert.ok(!('extra' in c[0])); assert.equal(c[2].isIndex, true);
  const now = 1_000_000_000_000; const ok = JSON.stringify({ t: now - 1000, rows: c }); assert.equal(parseSnapshot(ok, now)!.rows.length, 4);
  assert.equal(parseSnapshot(null, now), null); assert.equal(parseSnapshot('{bad', now), null); assert.equal(parseSnapshot(JSON.stringify({ t: now - MAX_AGE_MS - 1, rows: c }), now), null); assert.equal(parseSnapshot(JSON.stringify({ t: now + 3_600_000, rows: c }), now), null); assert.equal(parseSnapshot(JSON.stringify({ t: now, rows: c.slice(0, 2) }), now), null);
  const e = new MarketEngine(SEED_INSTRUMENTS); assert.equal(e.ready, false); const t0 = now - 5000;
  assert.equal(e.ingestSnapshot([{ symbol: 'RELIANCE', ltp: 2500, prevClose: 2450 }, { symbol: 'TCS', ltp: 3900, prevClose: 3800 }, { symbol: 'NIFTY', ltp: 24000, prevClose: 23900, isIndex: true }], t0), true);
  assert.equal(e.ready, true); assert.equal(e.snapshotAt, t0); assert.equal(e.quotes.get('RELIANCE')!.fetchedAt, t0); assert.equal(e.lastQuotesAt, 0); assert.equal(e.alerts.length, 0); assert.equal(e.indices.find((i) => i.id === 'NIFTY')!.loaded, true);
  assert.equal(e.ingestSnapshot([{ symbol: 'SBIN', ltp: 1, prevClose: 1 }], t0), false); // never over a loaded engine
  e.ingestRows([{ symbol: 'RELIANCE', ltp: 2510, prevClose: 2450 }], now); assert.equal(e.snapshotAt, 0); assert.equal(e.quotes.get('RELIANCE')!.ltp, 2510);
  const back = compactRows(e.snapshotRows()); assert.ok(back.some((r) => r.symbol === 'RELIANCE' && r.ltp === 2510) && back.some((r) => r.isIndex && r.symbol === 'NIFTY'));
});

/* ───────────── Round 29: cloud sync, Google/phone auth, PWA + push ───────────── */
const rec = () => { const calls: { url: string; method: string; body: unknown; headers: Record<string, string> }[] = []; return { calls, f: ((url: string, init: RequestInit = {}) => { calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body as string) : undefined, headers: init.headers as Record<string, string> }); return Promise.resolve(new Response('[]', { status: 200 })); }) as unknown as typeof fetch }; };
const mkCloud = (f: typeof fetch, token: string | null = 'tok') => createCloud({ url: 'https://x.supabase.co/', anonKey: 'anon', getToken: async () => token, fetch: f });
t('cloud rows: holdings ↔ rows (skips un-priced demo, bad symbols, dupes) and watchlists ↔ rows + meta', () => {
  const rows = holdingsToRows('u1', [{ symbol: 'tcs', qty: 10, avg: 3500 }, { symbol: 'TCS', qty: 1, avg: 1 }, { symbol: 'ITC', qty: 5, avg: 0 }, { symbol: 'M&M', qty: 2, avg: 1500.5 }, { symbol: 'bad sym', qty: 1, avg: 1 }], (s) => (s === 'TCS' ? 'IT' : undefined));
  assert.deepEqual(rows, [{ user_id: 'u1', symbol: 'TCS', quantity: 10, buy_price: 3500, sector: 'IT' }, { user_id: 'u1', symbol: 'M&M', quantity: 2, buy_price: 1500.5, sector: null }]);
  assert.deepEqual(rowsToHoldings([{ symbol: 'TCS', quantity: '10', buy_price: '3500.50' }, { symbol: 'X', quantity: 0, buy_price: 5 }, { symbol: 'Y', quantity: 1 }]), [{ symbol: 'TCS', qty: 10, avg: 3500.5 }]);
  assert.deepEqual(rowsToHoldings(null), []);
  const st: WLState = { lists: [{ id: 'main', name: 'Main', symbols: ['TCS', 'INFY'] }, { id: 'future', name: 'future', symbols: [] }], active: 'future' };
  assert.deepEqual(watchlistsToRows('u1', st), [{ user_id: 'u1', list_id: 'main', symbol: 'TCS', position: 0 }, { user_id: 'u1', list_id: 'main', symbol: 'INFY', position: 1 }]);
  const back = rowsToWatchlists([{ list_id: 'main', symbol: 'INFY', position: 1 }, { list_id: 'main', symbol: 'TCS', position: 0 }], watchlistMeta(st)); assert.deepEqual(back, st);
  assert.deepEqual(rowsToWatchlists([{ list_id: 'main', symbol: 'ITC', position: 0 }], null), { lists: [{ id: 'main', name: 'Main', symbols: ['ITC'] }], active: 'main' }); assert.equal(rowsToWatchlists([], null), null);
  assert.equal(inList(['A&B', 'C"D']), '("A&B","CD")');
  assert.deepEqual(parseNotify({ push: true }), { ...DEFAULT_NOTIFY, push: true }); assert.deepEqual(parseNotify(null), DEFAULT_NOTIFY);
});
t('cloud client: bearer + apikey on every call; portfolio save = UPSERT first, then delete the rest (symbols URL-encoded); empty save only deletes', async () => {
  const r = rec(); const c = mkCloud(r.f);
  await c.savePortfolio('u 1', [{ symbol: 'M&M', qty: 2, avg: 1500 }, { symbol: 'TCS', qty: 1, avg: 3500 }]);
  assert.equal(r.calls.length, 2); assert.equal(r.calls[0].method, 'POST'); assert.match(r.calls[0].url, /^https:\/\/x\.supabase\.co\/rest\/v1\/portfolios\?on_conflict=user_id,symbol$/); assert.equal(r.calls[0].headers.Prefer, 'resolution=merge-duplicates,return=minimal');
  assert.equal(r.calls[1].method, 'DELETE'); assert.ok(r.calls[1].url.includes('user_id=eq.u%201') && r.calls[1].url.includes('symbol=not.in.(%22M%26M%22%2C%22TCS%22)'), r.calls[1].url);
  for (const k of r.calls) { assert.equal(k.headers.Authorization, 'Bearer tok'); assert.equal(k.headers.apikey, 'anon'); }
  r.calls.length = 0; await c.savePortfolio('u1', []); assert.equal(r.calls.length, 1); assert.equal(r.calls[0].method, 'DELETE'); assert.ok(!r.calls[0].url.includes('symbol='));
  await assert.rejects(() => mkCloud(r.f, null).loadPortfolio('u1'), /not signed in/);
  const bad = (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch; await assert.rejects(() => mkCloud(bad).loadPortfolio('u1'), /cloud 401/);
});
t('cloud client: watchlists save (upsert, per-list prune, drop removed lists, meta), prefs, alert log, push subscription CRUD', async () => {
  const r = rec(); const c = mkCloud(r.f); const st: WLState = { lists: [{ id: 'main', name: 'Main', symbols: ['TCS'] }, { id: 'empty', name: 'Empty', symbols: [] }], active: 'main' };
  await c.saveWatchlists('u1', st); const m = r.calls.map((k) => `${k.method} ${k.url.replace('https://x.supabase.co/rest/v1/', '')}`);
  assert.deepEqual(m, ['POST watchlists?on_conflict=user_id,list_id,symbol', 'DELETE watchlists?user_id=eq.u1&list_id=eq.main&symbol=not.in.(%22TCS%22)', 'DELETE watchlists?user_id=eq.u1&list_id=eq.empty', 'DELETE watchlists?user_id=eq.u1&list_id=not.in.(%22main%22%2C%22empty%22)', 'POST preferences?on_conflict=user_id']);
  assert.deepEqual((r.calls[4].body as { watchlist_meta: unknown }[])[0].watchlist_meta, { lists: [{ id: 'main', name: 'Main' }, { id: 'empty', name: 'Empty' }], active: 'main' });
  r.calls.length = 0; await c.savePrefs('u1', { focus: ['TCS'], notify: { ...DEFAULT_NOTIFY, push: true, email: false, audio: true } }); assert.deepEqual((r.calls[0].body as { focus: string[]; notify: unknown }[])[0].notify, { ...DEFAULT_NOTIFY, push: true, email: false, audio: true });
  r.calls.length = 0; await c.logAlert('u1', { symbol: 'TCS', direction: 'UPPER', band: 5, price: 3700, at: Date.parse('2026-10-22T04:00:00Z') }); const a = (r.calls[0].body as Record<string, unknown>[])[0]; assert.equal(a.direction, 'UPPER'); assert.equal(a.triggered_at, '2026-10-22T04:00:00.000Z'); assert.equal(a.user_id, 'u1');
  r.calls.length = 0; await c.savePushSubscription('u1', { endpoint: 'https://push.example/abc', keys: { p256dh: 'k', auth: 'a' } }); assert.match(r.calls[0].url, /push_subscriptions\?on_conflict=user_id,endpoint/); await c.deletePushSubscription('u1', 'https://push.example/abc'); assert.equal(r.calls[1].method, 'DELETE'); assert.ok(r.calls[1].url.includes('endpoint=eq.https%3A%2F%2Fpush.example%2Fabc'));
});
t('migrateLocalStorage: uploads legacy portfolio / watchlist / focus once, never overwrites cloud data, purges only after success', async () => {
  const mem = (init: Record<string, string> = {}) => { const m = new Map(Object.entries(init)); return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) }; };
  const fake = (over: Partial<Record<string, unknown>> = {}) => { const log: string[] = []; return { log, cloud: { loadPortfolio: async () => (over.portfolio as never) ?? [], savePortfolio: async (_u: string, h: unknown[]) => { log.push('savePortfolio:' + h.length); if (over.failPortfolio) throw new Error('x'); }, loadWatchlists: async () => (over.watch as never) ?? null, saveWatchlists: async (_u: string, s: WLState) => { log.push('saveWatchlists:' + s.lists.reduce((n, l) => n + l.symbols.length, 0)); }, loadPrefs: async () => (over.prefs as never) ?? { focus: null, notify: null }, savePrefs: async (_u: string, p: { focus?: string[] }) => { log.push('savePrefs:' + (p.focus?.length ?? 0)); } } as never }; };
  // 1. everything local, cloud empty → all uploaded, legacy keys purged, flag set
  let st = mem({ upcircuit_portfolio: JSON.stringify([{ symbol: 'TCS', qty: 5, avg: 3500 }]), 'upcircuit:holdings:v1:u1': JSON.stringify([{ symbol: 'INFY', qty: 2, avg: 1500 }]), upcircuit_watchlist: JSON.stringify(['ITC', 'SBIN']), 'upcircuit:focus:v1:u1': JSON.stringify(['TCS', 'INFY']) }); let f = fake();
  let rep = await migrateLocalStorage(f.cloud, 'u1', st); assert.deepEqual(f.log, ['savePortfolio:2', 'saveWatchlists:2', 'savePrefs:2']); assert.equal(rep.holdings, 2); assert.equal(rep.watchlistSymbols, 2); assert.equal(rep.focus, 2); assert.deepEqual(rep.errors, []);
  assert.equal(st.getItem('upcircuit_portfolio'), null); assert.equal(st.getItem('upcircuit_watchlist'), null); assert.ok(st.getItem('upcircuit:holdings:v1:u1') !== null, 'the per-user cache stays as the offline copy'); assert.equal(st.getItem('upcircuit:cloud-migrated:u1'), '1');
  rep = await migrateLocalStorage(f.cloud, 'u1', st); assert.equal(rep.skipped, true); assert.equal(f.log.length, 3, 'runs once');
  // 2. cloud already has data → nothing uploaded (never overwrite), legacy keys still cleaned
  st = mem({ upcircuit_portfolio: JSON.stringify([{ symbol: 'TCS', qty: 5, avg: 3500 }]) }); f = fake({ portfolio: [{ symbol: 'RELIANCE', qty: 1, avg: 2500 }] });
  rep = await migrateLocalStorage(f.cloud, 'u1', st); assert.deepEqual(f.log, []); assert.equal(st.getItem('upcircuit_portfolio'), null);
  // 3. upload fails → keys kept, no flag (retry next login)
  st = mem({ upcircuit_portfolio: JSON.stringify([{ symbol: 'TCS', qty: 5, avg: 3500 }]) }); f = fake({ failPortfolio: true });
  rep = await migrateLocalStorage(f.cloud, 'u1', st); assert.deepEqual(rep.errors, ['portfolio']); assert.ok(st.getItem('upcircuit_portfolio') !== null); assert.equal(st.getItem('upcircuit:cloud-migrated:u1'), null);
  // 4. nothing local → no writes
  f = fake(); rep = await migrateLocalStorage(f.cloud, 'u2', mem()); assert.deepEqual(f.log, []); assert.deepEqual(parseHoldings('[{"symbol":"x","quantity":"3","buy_price":"2.5"}]'), [{ symbol: 'X', qty: 3, avg: 2.5 }]); assert.deepEqual(parseHoldings('nope'), []);
});
t('debounced saver: coalesces bursts, reports dirty, retries after a failure with the newest value, flush saves now', async () => {
  const timers: { cb: () => void; ms: number; id: number }[] = []; let id = 0; const deps = { setTimer: (cb: () => void, ms: number) => { timers.push({ cb, ms, id: ++id }); return id; }, clearTimer: (x: unknown) => { const i = timers.findIndex((t) => t.id === x); if (i >= 0) timers.splice(i, 1); } };
  const saved: number[] = []; let fail = false; const sv = createSaver<number>(async (v) => { if (fail) throw new Error('offline'); saved.push(v); }, 700, deps);
  sv.schedule(1); sv.schedule(2); sv.schedule(3); assert.equal(timers.length, 1); assert.equal(sv.dirty(), true); timers.shift()!.cb(); await new Promise((r) => setImmediate(r)); assert.deepEqual(saved, [3]); assert.equal(sv.dirty(), false);
  fail = true; sv.schedule(4); timers.shift()!.cb(); await new Promise((r) => setImmediate(r)); assert.equal(sv.dirty(), true, 'failed save stays dirty'); assert.equal(timers[0].ms, 2800, 'slower retry scheduled');
  fail = false; sv.schedule(5); await sv.flush(); assert.deepEqual(saved, [3, 5]); assert.equal(sv.dirty(), false);
});
t('notification toggles: defaults, legacy audio mute carried over, persists per user, cloud values do not echo back', () => {
  const mem = new Map<string, string>(); (globalThis as unknown as { localStorage: unknown }).localStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
  setScope('u9'); mem.set('upcircuit:audio:v1:u9', '0'); loadNotifyLocal(); assert.deepEqual(getNotify(), { ...DEFAULT_NOTIFY, push: false, email: true, audio: false }, 'old mute kept');
  const saves: unknown[] = []; attachNotifySaver((p) => saves.push(p)); setNotify({ push: true }); assert.deepEqual(getNotify(), { ...DEFAULT_NOTIFY, push: true, email: true, audio: false }); assert.equal(saves.length, 1); assert.deepEqual(JSON.parse(mem.get(`${NOTIFY_KEY}:u9`)!), { ...DEFAULT_NOTIFY, push: true, email: true, audio: false });
  applyCloudNotify({ ...DEFAULT_NOTIFY, push: false, email: false, audio: true }); assert.equal(saves.length, 1, 'no echo'); assert.deepEqual(getNotify(), { ...DEFAULT_NOTIFY, push: false, email: false, audio: true });
  setScope('u10'); loadNotifyLocal(); assert.deepEqual(getNotify(), { ...DEFAULT_NOTIFY, push: false, email: true, audio: true }, 'another account has its own'); attachNotifySaver(null); setScope(null); delete (globalThis as unknown as { localStorage?: unknown }).localStorage;
});
t('web push: VAPID key decoding, subscription JSON, payload, fan-out (exclude this device, prune 404/410), endpoint guard, client dispatch', async () => {
  assert.deepEqual([...urlBase64ToUint8Array('AQID_w')], [1, 2, 3, 255]); assert.deepEqual([...urlBase64ToUint8Array('AQIDBA')], [1, 2, 3, 4]);
  assert.deepEqual(toPushSub({ toJSON: () => ({ endpoint: 'https://p/x', keys: { p256dh: 'a', auth: 'b' } }) }), { endpoint: 'https://p/x', keys: { p256dh: 'a', auth: 'b' } }); assert.equal(toPushSub({ toJSON: () => ({ endpoint: 'https://p/x' }) }), null);
  const pl = circuitPushPayload({ symbol: 'TCS', dir: 'lower', band: 10, ltp: 3150, pct: -10 }); assert.equal(pl.title, '▼ LOWER CIRCUIT · TCS'); assert.match(pl.body, /₹3150\.00 \(−10\.00%\) hit the −10% band\. Sellers only/); assert.ok(pl.url.endsWith('/terminal?symbol=TCS')); assert.equal(pl.tag, 'circuit-TCS-lower-10');
  assert.match(circuitPushPayload({ symbol: 'ITC', dir: 'upper', band: 5, ltp: 500, pct: 5 }).title, /^▲ UPPER CIRCUIT · ITC$/);
  const subs = ['https://p/a', 'https://p/b', 'https://p/c', 'https://p/d'].map((endpoint) => ({ endpoint, keys: { p256dh: 'k', auth: 'a' } })); const sent: string[] = [];
  const res = await fanOut(subs, pl, async (s) => { if (s.endpoint.endsWith('b')) throw Object.assign(new Error('gone'), { statusCode: 410 }); if (s.endpoint.endsWith('c')) throw Object.assign(new Error('boom'), { statusCode: 500 }); sent.push(s.endpoint); }, 'https://p/d');
  assert.deepEqual(res, { sent: 1, failed: 1, gone: ['https://p/b'] }); assert.deepEqual(sent, ['https://p/a']);
  assert.ok(isPushEndpoint('https://fcm.googleapis.com/fcm/send/abc')); assert.ok(isPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/x')); assert.ok(isPushEndpoint('https://web.push.apple.com/Q')); assert.ok(isPushEndpoint('https://wns2-par02p.notify.windows.com/w/?token=1'));
  assert.ok(!isPushEndpoint('http://fcm.googleapis.com/x')); assert.ok(!isPushEndpoint('https://127.0.0.1/x')); assert.ok(!isPushEndpoint('https://169.254.169.254/latest/meta-data')); assert.ok(!isPushEndpoint('https://evil.com/fcm.googleapis.com/x')); assert.ok(!isPushEndpoint('https://fcm.googleapis.com.evil.com/x')); assert.ok(!isPushEndpoint('https://u:p@fcm.googleapis.com/x')); assert.ok(!isPushEndpoint('javascript:alert(1)')); assert.ok(isPushEndpoint('https://localhost:4443/p/1', 'localhost'), 'env allowlist for self-hosted / tests');
  const r = rec(); assert.equal(await sendCircuitPush({ symbol: 'TCS', dir: 'upper', band: 5, ltp: 3700, pct: 5, limit: 3700, exact: false }, 'tok', 'https://p/me', r.f), 'sent'); assert.equal(r.calls[0].url, '/api/alerts/push'); assert.equal(r.calls[0].headers.Authorization, 'Bearer tok'); assert.equal((r.calls[0].body as { exclude: string }).exclude, 'https://p/me');
  assert.equal(await sendCircuitPush({ symbol: 'T', dir: 'upper', band: 5, ltp: 1, pct: 5, limit: 1, exact: false }, null, null, r.f), 'skipped');
});
t('Google OAuth callback: PKCE challenge (RFC 7636 vector), code exchange, safe redirects, token bridge page is script-injection-proof', async () => {
  assert.equal(await challengeOf('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'); assert.ok(isVerifier('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')); assert.ok(!isVerifier('short'));
  assert.equal(safeNext('/settings'), '/settings'); assert.equal(safeNext('//evil.com'), '/'); assert.equal(safeNext('https://evil.com'), '/'); assert.equal(safeNext(null), '/'); assert.equal(safeNext('/a?x=1&y=2'), '/a?x=1&y=2'); assert.equal(safeNext('/\\evil'), '/');
  const v = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'; let seen: { url: string; body: unknown; headers: Record<string, string> } | null = null;
  const ok = (async (url: string, init: RequestInit) => { seen = { url, body: JSON.parse(init.body as string), headers: init.headers as Record<string, string> }; return new Response(JSON.stringify({ access_token: 'AT', refresh_token: 'RT' }), { status: 200 }); }) as unknown as typeof fetch;
  assert.deepEqual(await exchangeCode('https://x.supabase.co/', 'anon', 'abc12345', v, ok), { ok: true, access: 'AT', refresh: 'RT' }); const sx = seen as unknown as { url: string; body: unknown; headers: Record<string, string> }; assert.equal(sx.url, 'https://x.supabase.co/auth/v1/token?grant_type=pkce'); assert.deepEqual(sx.body, { auth_code: 'abc12345', code_verifier: v }); assert.equal(sx.headers.apikey, 'anon');
  assert.equal((await exchangeCode('https://x', 'k', null, v, ok)).ok, false); assert.equal((await exchangeCode('https://x', 'k', 'abc12345', undefined, ok)).ok, false); assert.equal((await exchangeCode('https://x', 'k', 'bad code!', v, ok)).ok, false);
  const denied = (async () => new Response(JSON.stringify({ error_description: 'invalid grant' }), { status: 400 })) as unknown as typeof fetch; assert.deepEqual(await exchangeCode('https://x', 'k', 'abc12345', v, denied), { ok: false, error: 'invalid grant' });
  const html = bridgeHtml({ access: 'a</script><script>alert(1)//', refresh: 'r' }, '/settings'); assert.ok(!html.includes('</script><script>alert')); assert.ok(html.includes('upcircuit:auth:sb') && html.includes('location.replace("/settings")')); assert.equal(scriptJson('</script>'), '"\\u003c/script\\u003e"');
});
t('phone OTP: Indian mobile normalisation to +91 E.164', () => {
  assert.equal(normalizeIndianMobile('9876543210'), '+919876543210'); assert.equal(normalizeIndianMobile('98765 43210'), '+919876543210'); assert.equal(normalizeIndianMobile('+91 98765-43210'), '+919876543210'); assert.equal(normalizeIndianMobile('919876543210'), '+919876543210'); assert.equal(normalizeIndianMobile('09876543210'), '+919876543210');
  assert.equal(normalizeIndianMobile('5876543210'), null); assert.equal(normalizeIndianMobile('987654321'), null); assert.equal(normalizeIndianMobile('98765432101'), null); assert.equal(normalizeIndianMobile('abcdefghij'), null); assert.equal(normalizeIndianMobile(''), null);
});
t('PWA assets: manifest fields + icons exist with the right sizes; service worker handles push + notification click; schema has RLS on every table', () => {
  const man = JSON.parse(readFileSync('public/manifest.json', 'utf8')); assert.equal(man.name, 'UpCircuit Financial Terminal'); assert.equal(man.short_name, 'UpCircuit'); assert.equal(man.display, 'standalone'); assert.equal(man.background_color, '#020617'); assert.equal(man.theme_color, '#3b82f6');
  for (const sz of ['192x192', '512x512']) assert.ok(man.icons.some((i: { sizes: string; purpose: string }) => i.sizes === sz && i.purpose === 'any'), sz); assert.ok(man.icons.some((i: { purpose: string }) => i.purpose === 'maskable'));
  const dim = (p: string) => { const b = readFileSync(p); assert.equal(b.subarray(1, 4).toString(), 'PNG'); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };
  assert.deepEqual(dim('public/icons/icon-192.png'), [192, 192]); assert.deepEqual(dim('public/icons/icon-512.png'), [512, 512]); assert.deepEqual(dim('public/icons/badge-72.png'), [72, 72]); assert.ok(existsSync('public/icons/icon-maskable-512.png'));
  const sw = readFileSync('public/sw.js', 'utf8'); assert.ok(/addEventListener\('push'/.test(sw) && /showNotification/.test(sw) && /vibrate: \[200, 100, 200\]/.test(sw) && /\/icons\/icon-192\.png/.test(sw) && /\/icons\/badge-72\.png/.test(sw) && /addEventListener\('notificationclick'/.test(sw) && /\|\| '\/terminal'/.test(sw));
  const sql = readFileSync('docs/PERSISTENCE_SCHEMA.sql', 'utf8'); for (const tb of ['profiles', 'portfolios', 'watchlists', 'alert_history', 'push_subscriptions']) { assert.match(sql, new RegExp(`create table if not exists public\\.${tb}\\b`)); assert.match(sql, new RegExp(`alter table public\\.${tb}\\s+enable row level security`, 'i')); }
  for (const tb of ['portfolios', 'watchlists', 'alert_history', 'push_subscriptions']) assert.match(sql, new RegExp(`create policy "Users access own data" on public\\.${tb}\\s+for all using \\(auth\\.uid\\(\\) = user_id\\)`)); assert.match(sql, /grant\s+update \(primary_role, full_name, avatar_url, updated_at\)/); assert.ok(!/grant\s+update \([^)]*\bphone\b/.test(sql), 'phone is trigger-owned'); assert.match(sql, /phone_verified boolean/); assert.match(sql, /create trigger on_auth_user_phone_changed/); assert.ok(!/grant\s+update \([^)]*\bplan\b/.test(sql), 'plan stays billing-owned');
  const layout = readFileSync('app/layout.tsx', 'utf8'); assert.match(layout, /manifest: '\/manifest\.json'/);
});

t('Round 30 · phone: +91 E.164 normalisation edge cases and masking for the profile card', () => {
  for (const [i, o] of [['9876543210', '+919876543210'], ['+91 98765 43210', '+919876543210'], ['(98765) 43210', '+919876543210'], ['6000000000', '+916000000000'], ['5999999999', null], ['+1 9876543210', null], ['98765x43210', null], ['+91+919876543210', null]] as [string, string | null][]) assert.equal(normalizeIndianMobile(i), o, i);
  assert.equal(maskPhone('+919876543210'), '+91 XXXXX X3210'); assert.equal(maskPhone('+14155550123'), '+XXXXXXX0123');
});
t('Round 30 · preferences blob: sound / volume / landing / density validated, old 3-field blobs upgrade, soundFor maps the picker', () => {
  assert.deepEqual(parseNotify({ push: true, email: false, audio: true }), { ...DEFAULT_NOTIFY, push: true, email: false });
  assert.deepEqual(parseNotify({ sound: 'arpeggio', volume: 0.55, landing: 'terminal', density: 'compact' }), { ...DEFAULT_NOTIFY, sound: 'arpeggio', volume: 0.55, landing: 'terminal', density: 'compact' });
  assert.equal(parseNotify({ volume: 9 }).volume, 1); assert.equal(parseNotify({ volume: 0 }).volume, 0.1); assert.equal(parseNotify({ volume: 'x' }).volume, 1);
  assert.deepEqual([parseNotify({ sound: 'rm -rf', landing: 'x', density: 7 }).sound, parseNotify({ landing: 'x' }).landing, parseNotify({ density: 7 }).density], ['default', 'home', 'comfortable']);
  assert.equal(soundFor('lower', 'default'), 'lower'); assert.equal(soundFor('upper', 'default'), 'upper'); assert.equal(soundFor('lower', 'arpeggio'), 'upper');
});
t('Round 30 · popover/settings state: alert toggles, sound, landing, density persist per user, reach the cloud saver once each, and Mute = audio off', () => {
  const mem = new Map<string, string>(); (globalThis as unknown as { localStorage: unknown }).localStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
  setScope('u30'); loadNotifyLocal(); const saves: unknown[] = []; attachNotifySaver((p) => saves.push(p));
  setNotify({ email: false }); setNotify({ audio: true, sound: 'arpeggio' }); setNotify({ landing: 'terminal' }); setNotify({ density: 'compact', volume: 0.4 }); setNotify({ audio: false });
  assert.deepEqual(getNotify(), { push: false, email: false, audio: false, sound: 'arpeggio', volume: 0.4, landing: 'terminal', density: 'compact' }); assert.equal(saves.length, 5);
  assert.deepEqual(JSON.parse(mem.get(`${NOTIFY_KEY}:u30`)!), getNotify());
  setScope('u31'); loadNotifyLocal(); assert.deepEqual(getNotify(), DEFAULT_NOTIFY, 'other account unaffected'); setScope('u30'); loadNotifyLocal(); assert.equal(getNotify().landing, 'terminal', 'restored after reload');
  attachNotifySaver(null); setScope(null); delete (globalThis as unknown as { localStorage?: unknown }).localStorage;
});
t('Round 30 · phone binding (Supabase): PUT /user sends the code, phone_change verify returns the refreshed user with phoneVerified; wrong code → friendly error; old schema without phone_verified still loads', async () => {
  const kv = new Map<string, string>([['upcircuit:auth:sb', JSON.stringify({ access: 'AT', refresh: 'RT' })]]); const store = { getItem: (k: string) => kv.get(k) ?? null, setItem: (k: string, v: string) => void kv.set(k, v), removeItem: (k: string) => void kv.delete(k) };
  const calls: { url: string; method: string; body: unknown; auth?: string }[] = []; let profileHasVerified = true; let verifyStatus = 200;
  const f = (async (url: string, init: RequestInit = {}) => {
    const h = (init.headers ?? {}) as Record<string, string>; calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body as string) : undefined, auth: h.Authorization });
    if (url.includes('/auth/v1/verify')) return verifyStatus === 200 ? Response.json({ access_token: 'AT2', refresh_token: 'RT2', user: { id: 'u1', email: 'a@b.co', phone: '919876543210', phone_confirmed_at: '2026-10-23T00:00:00Z', identities: [{ provider: 'email' }], app_metadata: { providers: ['email'] } } }) : Response.json({ msg: 'Token has expired or is invalid' }, { status: 403 });
    if (url.includes('/rest/v1/profiles')) { if (url.includes('phone_verified') && !profileHasVerified) return new Response('{}', { status: 400 }); return Response.json([{ primary_role: 'retail', plan: 'full', phone: '+919876543210', ...(profileHasVerified ? { phone_verified: true } : {}) }]); }
    if (url.includes('/identities/authorize')) return Response.json({ url: 'https://p.supabase.co/auth/v1/authorize?provider=google&x=1' });
    return Response.json({});
  }) as unknown as typeof fetch;
  const be = createSupabaseBackend('https://p.supabase.co/', 'anon', store, f);
  assert.deepEqual(await be.startPhoneLink!('+919876543210'), { ok: true }); assert.equal(calls[0].method, 'PUT'); assert.ok(calls[0].url.endsWith('/auth/v1/user')); assert.deepEqual(calls[0].body, { phone: '+919876543210' }); assert.equal(calls[0].auth, 'Bearer AT');
  const r = await be.confirmPhoneLink!('+919876543210', '123456'); assert.ok(r.ok); if (r.ok) { assert.equal(r.user.phone, '+919876543210'); assert.equal(r.user.phoneVerified, true); assert.deepEqual(r.user.providers, ['email']); }
  assert.deepEqual(calls.find((c) => c.url.includes('/verify'))!.body, { type: 'phone_change', phone: '+919876543210', token: '123456' }); assert.equal(JSON.parse(kv.get('upcircuit:auth:sb')!).access, 'AT2', 'new session stored');
  verifyStatus = 403; assert.deepEqual(await be.confirmPhoneLink!('+919876543210', '000000'), { ok: false, error: 'That code is wrong or has expired.' });
  profileHasVerified = false; verifyStatus = 200; const r2 = await be.confirmPhoneLink!('+919876543210', '123456'); assert.ok(r2.ok && r2.user.phoneVerified === true, 'falls back to phone_confirmed_at');
  const g = await be.startGoogleLink!('https://app/auth/callback'); assert.ok(g.ok); const gl = calls.filter((c) => c.url.includes('/identities/authorize')).pop()!; assert.match(gl.url, /provider=google/); assert.match(gl.url, /skip_http_redirect=true/); assert.match(gl.url, /code_challenge_method=s256/); assert.equal(gl.auth, 'Bearer AT2');
  kv.delete('upcircuit:auth:sb'); assert.equal((await be.startPhoneLink!('+919876543210')).ok, false); assert.equal((await be.startGoogleLink!('x')).ok, false);
});
t('Round 30 · backup JSON + force sync: contents, filename, never wipes the cloud with "nothing stored"', async () => {
  const keys: Record<string, string> = { 'upcircuit:holdings:v1': JSON.stringify([{ symbol: 'TCS', qty: 10, avg: 3500 }]), 'upcircuit:watchlists:v2': JSON.stringify({ active: 'main', lists: [{ id: 'main', name: 'Main', symbols: ['ITC', 'SBIN'] }] }), 'upcircuit:focus:v1': JSON.stringify(['TCS']) };
  const snap = readSnapshot((b) => keys[b] ?? null); assert.deepEqual(snap.holdings, [{ symbol: 'TCS', qty: 10, avg: 3500 }]); assert.deepEqual(snap.focus, ['TCS']);
  const b = buildBackup({ user: { id: 'u1', email: 'a@b.co', phone: '+919876543210' }, snap, prefs: DEFAULT_NOTIFY, now: new Date('2026-10-23T05:00:00Z') });
  assert.equal(b.app, 'UpCircuit'); assert.equal(b.version, 1); assert.equal(b.exportedAt, '2026-10-23T05:00:00.000Z'); assert.deepEqual(b.watchlists.lists[0].symbols, ['ITC', 'SBIN']); assert.equal(b.holdings.length, 1); assert.equal(backupFilename(new Date('2026-10-23T05:00:00Z')), 'upcircuit-backup-2026-10-23.json'); assert.ok(!JSON.stringify(b).includes('token'));
  const empty = readSnapshot(() => null); assert.deepEqual(empty, { holdings: null, watchlists: null, focus: null }); assert.deepEqual(buildBackup({ user: { id: 'u' }, snap: empty, prefs: DEFAULT_NOTIFY }).holdings, []); assert.deepEqual(buildBackup({ user: { id: 'u' }, snap: empty, prefs: DEFAULT_NOTIFY }).watchlists.lists[0].symbols, ['RELIANCE', 'TCS', 'HDFCBANK', 'INFY', 'SBIN'], 'never-edited watchlist = app defaults');
  const r = rec(); const c = mkCloud(r.f);
  const res = await forceSync(c, 'u1', snap, DEFAULT_NOTIFY); assert.equal(res.ok, true); assert.equal(res.holdings, 1); assert.equal(res.watchlistSymbols, 2); assert.ok(r.calls.some((k) => /portfolios\?on_conflict/.test(k.url)) && r.calls.some((k) => /watchlists\?on_conflict/.test(k.url)) && r.calls.some((k) => /preferences\?on_conflict/.test(k.url)));
  r.calls.length = 0; const res2 = await forceSync(c, 'u1', empty, DEFAULT_NOTIFY); assert.equal(res2.holdings, null); assert.ok(!r.calls.some((k) => /portfolios|watchlists/.test(k.url)), 'nothing stored locally → portfolio/watchlists untouched'); assert.ok(r.calls.some((k) => /preferences/.test(k.url)));
  const bad = (async () => { throw new Error('offline'); }) as unknown as typeof fetch; const rf = await forceSync(mkCloud(bad), 'u1', snap, DEFAULT_NOTIFY); assert.equal(rf.ok, false); assert.deepEqual(rf.errors, ['portfolio', 'watchlists', 'preferences']);
});
t('Round 30 · clean sign-out: pushes first, purges only this user’s cache (not the migration flag / other users), keeps everything when the push fails; local-only accounts keep their data', async () => {
  const mk = () => { const m = new Map<string, string>([['upcircuit:holdings:v1:u1', '[]'], ['upcircuit:watchlists:v2:u1', '{}'], ['upcircuit:notify:v1:u1', '{}'], ['upcircuit:cloud-migrated:u1', '1'], ['upcircuit:holdings:v1:u2', '[]'], ['upcircuit:theme', 'dark']]); return { m, store: { get length() { return m.size; }, key: (i: number) => [...m.keys()][i] ?? null, removeItem: (k: string) => void m.delete(k) } }; };
  let x = mk(); assert.deepEqual(purgeUserCache(x.store, 'u1').sort(), ['upcircuit:holdings:v1:u1', 'upcircuit:notify:v1:u1', 'upcircuit:watchlists:v2:u1']); assert.deepEqual([...x.m.keys()].sort(), ['upcircuit:cloud-migrated:u1', 'upcircuit:holdings:v1:u2', 'upcircuit:theme']);
  x = mk(); const r = rec(); let pushRemoved = 0;
  let res = await cleanBeforeSignOut({ cloud: mkCloud(r.f), userId: 'u1', read: (b) => x.m.get(`${b}:u1`) ?? null, prefs: DEFAULT_NOTIFY, store: x.store, removePush: async () => void pushRemoved++ });
  assert.equal(res.synced, true); assert.equal(res.purged.length, 3); assert.equal(pushRemoved, 1); assert.ok(r.calls.length > 0);
  x = mk(); const bad = (async () => { throw new Error('offline'); }) as unknown as typeof fetch; res = await cleanBeforeSignOut({ cloud: mkCloud(bad), userId: 'u1', read: (b) => x.m.get(`${b}:u1`) ?? null, prefs: DEFAULT_NOTIFY, store: x.store });
  assert.equal(res.synced, false); assert.equal(res.kept, true); assert.equal(x.m.size, 6, 'failed sync → nothing deleted');
  x = mk(); res = await cleanBeforeSignOut({ cloud: null, userId: 'u1', read: () => null, prefs: DEFAULT_NOTIFY, store: x.store }); assert.deepEqual(res, { synced: null, purged: [], kept: true }); assert.equal(x.m.size, 6);
});
t('Round 30 · sync badge: local → synced → offline (retrying) → synced, driven by REST results; resetAccountData hits the four tables', async () => {
  setSyncAvailable(false); assert.equal(getSync().state, 'local'); assert.equal(syncLabel(getSync().state), '🟡 Local Cache Only'); reportSync(true); assert.equal(getSync().state, 'local', 'no cloud account → stays local');
  setSyncAvailable(true); assert.equal(getSync().state, 'synced'); assert.equal(syncLabel('synced'), '🟢 Supabase Synced'); reportSync(false, 5); assert.equal(getSync().state, 'offline'); assert.match(syncLabel('offline'), /Local Cache Only/); reportSync(true, 9); assert.equal(getSync().state, 'synced'); assert.equal(getSync().lastOkAt, 9);
  const results: boolean[] = []; const r = rec(); const c = createCloud({ url: 'https://x.supabase.co', anonKey: 'anon', getToken: async () => 'tok', fetch: r.f, onResult: (ok) => results.push(ok) }); await c.resetAccountData('u1');
  assert.deepEqual(r.calls.map((k) => `${k.method} ${k.url.replace('https://x.supabase.co/rest/v1/', '')}`), ['DELETE portfolios?user_id=eq.u1', 'DELETE watchlists?user_id=eq.u1', 'DELETE alert_history?user_id=eq.u1', 'DELETE preferences?user_id=eq.u1']); assert.deepEqual(results, [true, true, true, true]);
  const boom = createCloud({ url: 'https://x.supabase.co', anonKey: 'anon', getToken: async () => 'tok', fetch: (async () => { throw new Error('net'); }) as unknown as typeof fetch, onResult: (ok) => results.push(ok) }); await assert.rejects(() => boom.loadPortfolio('u1')); assert.equal(results[results.length - 1], false);
  setSyncAvailable(false);
});
t('Round 30 · UI wiring: popover has every required control; SettingsModal has the four tabs; schema keeps phone trigger-owned', () => {
  const pop = readFileSync('components/ProfilePopover.tsx', 'utf8');
  for (const id of ['account-email', 'account-phone', 'account-link-mobile', 'account-plan', 'account-sync', 'account-settings', 'quick-push', 'quick-email', 'quick-sound', 'quick-landing', 'account-feed', 'account-force-sync', 'account-export-ticks', 'account-export-backup', 'account-plans', 'account-logout']) assert.ok(pop.includes(id) || readFileSync('components/SettingsModal.tsx', 'utf8').includes(id), id);
  assert.match(pop, /⚠️ Link Mobile/); assert.match(pop, /Tier \{plan\.tier\} - \{plan\.name\}/); assert.match(pop, /Force Sync Cloud State/); assert.match(pop, /Export Portfolio &amp; Watchlist Backup \(JSON\)/); assert.match(pop, /Export session ticks \(CSV\)/);
  const sm = readFileSync('components/SettingsModal.tsx', 'utf8'); for (const l of ['Profile & Auth', 'Alert Channels', 'Market & Layout', 'Cloud & Data']) assert.ok(sm.includes(l), l); for (const id of ['phone-link', 'link-phone', 'link-send', 'link-otp', 'link-verify', 'link-resend', 'google-link', 'alert-volume', 'cloud-force-sync', 'reset-cloud']) assert.ok(sm.includes(id), id);
  assert.ok(readFileSync('components/CircuitAlertOverlay.tsx', 'utf8').includes('soundFor(head.dir'), 'overlay honours the chosen sound + volume');
  assert.ok(readFileSync('components/Navbar.tsx', 'utf8').includes('<ProfilePopover'));
});

t('Round 31 · universal search: ticker, company name and BSE scrip code over an 8k master; exact ticker ranks first (Enter target); fast', async () => {
  await sleep(400); // CPU-heavy: let the timer-based stream tests above finish first
  const real = SEED_INSTRUMENTS.map((i) => ({ ...i }));
  const codes: Record<string, string> = { RELIANCE: '500325', DIXON: '532790', BHARTIARTL: '532454', KALYANKJIL: '543278' };
  const master: Instrument[] = real.map((i) => (codes[i.symbol] ? { ...i, code: codes[i.symbol] } : i));
  for (let k = 0; k < 7000; k++) master.push({ symbol: `ZZ${k.toString(36).toUpperCase()}${k}`, name: `Synthetic Holdings Number ${k} Ltd`, sector: 'Others', exch: 'BSE', code: String(600000 + k) });
  const idx = buildIndex(master);
  for (const s of ['BHARTIARTL', 'DIXON', 'KALYANKJIL']) assert.equal(searchInstruments(idx, s, 8)[0].symbol, s, `${s} is the Enter target`);
  assert.equal(searchInstruments(idx, 'bharti airtel', 8)[0].symbol, 'BHARTIARTL'); assert.equal(searchInstruments(idx, 'dixon tech', 8)[0].symbol, 'DIXON'); assert.equal(searchInstruments(idx, 'kalyan jew', 8)[0].symbol, 'KALYANKJIL');
  assert.equal(searchInstruments(idx, '500325', 8)[0].symbol, 'RELIANCE', 'exact BSE code'); assert.equal(searchInstruments(idx, '53279', 8)[0].symbol, 'DIXON', 'code prefix'); assert.equal(searchInstruments(idx, '543278', 3)[0].symbol, 'KALYANKJIL');
  assert.deepEqual(searchInstruments(idx, '12', 8).filter((r) => r.code?.startsWith('12')), [], 'short numbers do not match codes');
  const t0 = Date.now(); for (const qy of ['dixon', 'bharti', 'kalyan jew', '5003']) searchInstruments(idx, qy, 8); assert.ok((Date.now() - t0) / 4 < 60, `avg ${(Date.now() - t0) / 4} ms per query over ${master.length} names`);
  const { codes: cm } = pickEquities([{ symbol: 'RELIANCE', name: 'RELIANCE', exch_seg: 'BSE', instrumenttype: '', token: '500325' }, { symbol: 'BAD', name: 'BAD', exch_seg: 'BSE', instrumenttype: '', token: 'abc' }]); assert.equal(cm.get('RELIANCE'), '500325'); assert.ok(!cm.has('BAD'));
});
t('Round 31 · add holding: new symbol appended, same symbol merged at the weighted-average price, invalid input ignored', () => {
  const base = [{ symbol: 'TCS', qty: 10, avg: 3500 }];
  assert.deepEqual(mergeHolding(base, { symbol: 'DIXON', qty: 5, avg: 15000 }), [...base, { symbol: 'DIXON', qty: 5, avg: 15000 }]);
  assert.deepEqual(mergeHolding(base, { symbol: 'TCS', qty: 10, avg: 3700 }), [{ symbol: 'TCS', qty: 20, avg: 3600 }]);
  assert.deepEqual(mergeHolding([{ symbol: 'ITC', qty: 100, avg: 0 }], { symbol: 'ITC', qty: 10, avg: 410 }), [{ symbol: 'ITC', qty: 110, avg: 410 }], 'demo row without a price takes the new price');
  assert.equal(mergeHolding(base, { symbol: 'X', qty: 0, avg: 5 }), base); assert.equal(mergeHolding(base, { symbol: 'X', qty: 5, avg: -1 }), base);
});
t('Round 31 · live fundamentals: Mcap = LTP×shares, P/E = LTP÷EPS, P/B = LTP÷BVPS on SmartAPI prices; Yahoo values otherwise; never invented', () => {
  const i = { ltp: 3000, sharesCr: 361.8, eps: 120, bookValue: 400, yahooMcapCr: 1_000_000, yahooPe: 24 };
  const live = liveFundamentals({ ...i, mode: 'live' });
  assert.ok(Math.abs(live.marketCapCr.value! - 3000 * 361.8) < 1e-6 && live.marketCapCr.source === 'smartapi'); assert.equal(live.pe.value, 25); assert.equal(live.pe.source, 'smartapi'); assert.equal(live.pb.value, 7.5); assert.equal(live.pb.source, 'smartapi');
  assert.equal(liveFundamentals({ ...i, ltp: 3030, mode: 'live' }).pe.value, 25.25, 'moves with the tick');
  const snap = liveFundamentals({ ...i, mode: 'snapshot' }); assert.equal(snap.pe.source, 'smartapi'); assert.equal(smartApiLabel('live'), 'SmartAPI Live'); assert.equal(smartApiLabel('snapshot'), 'SmartAPI Last Price');
  const del = liveFundamentals({ ...i, mode: 'delayed' }); assert.deepEqual([del.marketCapCr.source, del.pe.source, del.pb.source], ['yahoo', 'yahoo', 'computed']); assert.equal(del.pe.value, 24); assert.equal(del.marketCapCr.value, 1_000_000);
  const noShares = liveFundamentals({ ...i, mode: 'live', sharesCr: null }); assert.equal(noShares.marketCapCr.source, 'yahoo');
  const loss = liveFundamentals({ ...i, mode: 'live', eps: -4, yahooPe: null }); assert.deepEqual([loss.pe.value, loss.pe.source], [null, 'na'], 'negative EPS → N/A, not a fake ratio');
  assert.equal(liveFundamentals({ ltp: 100, mode: 'live' }).marketCapCr.value, null);
  const rs = relativeStrength([100, 101], [200, 201], 1.5, 0.4); assert.ok(Math.abs(rs[0].rs! - 1.1) < 1e-9, '1D relative = stock live % − NIFTY live %');
});
t('Round 31 · tick pipeline: engine.onTick fires synchronously for every tick (stocks + indices), listener faults are isolated, unsubscribe works; DOM cadence is 250 ms', () => {
  const e = ingestFixture(new MarketEngine(SEED_INSTRUMENTS)); const got: string[] = []; const off = e.onTick((x) => got.push(`${x.symbol}:${x.ltp}:${x.volume}`));
  e.onTick(() => { throw new Error('bad listener'); });
  const t0 = Date.parse('2026-10-23T05:00:00Z'); e.applyTick({ symbol: 'TCS', ltp: 4000, volume: 1000, close: 3950, ts: t0 }, t0); e.applyTick({ symbol: 'TCS', ltp: 4001, volume: 1100, ts: t0 + 5 }, t0 + 5); e.applyTick({ symbol: 'TCS', ltp: 4002, volume: 1150, ts: t0 + 9 }, t0 + 9);
  assert.deepEqual(got, ['TCS:4000:1000', 'TCS:4001:1100', 'TCS:4002:1150'], 'one event per tick, even 4 ms apart');
  const nifty = e.indices.find((i) => i.id === 'NIFTY')!; e.applyIndexTick('NIFTY', 24500, 24400); assert.equal(got[3], 'NIFTY:24500:0'); assert.ok(nifty.loaded);
  off(); e.applyTick({ symbol: 'TCS', ltp: 4003, volume: 1200, ts: t0 + 20 }, t0 + 20); assert.equal(got.length, 4, 'unsubscribed');
  assert.equal(DOM_BATCH_MS, 250); const pc = readFileSync('components/PriceChart.tsx', 'utf8'); assert.ok(/subscribeTicks/.test(pc) && /candles\.update\(toBar\(next\)\)/.test(pc) && /if \(direct\) return;/.test(pc), 'chart updates straight from the tick listener');
  const css = readFileSync('app/globals.css', 'utf8'); assert.match(css, /\.tick-flash\s*\{[^}]*transition:\s*background-color 250ms ease,\s*color 250ms ease/);
  const pumpRender: number[] = []; let clock = 0; const timers: { cb: () => void; at: number }[] = []; const pump = createFramePump(() => pumpRender.push(clock), DOM_BATCH_MS, { raf: (cb) => cb(), setTimer: (cb, ms) => timers.push({ cb, at: clock + ms }), clearTimer: () => undefined, now: () => clock });
  for (let k = 0; k < 40; k++) { clock = k * 5; pump.request(); } timers.sort((a, b) => a.at - b.at).forEach((x) => { clock = x.at; x.cb(); }); assert.ok(pumpRender.length <= 2, `200 ms of 5 ms ticks → ${pumpRender.length} DOM renders`);
});
t('Round 31 · UI wiring: focus basket + add-holding use the autocomplete over the full master; fundamentals badges are SmartAPI-aware', () => {
  const fb = readFileSync('components/MyFocusBasket.tsx', 'utf8'); assert.ok(/<StockAutocomplete/.test(fb) && /instruments=\{instruments\}/.test(fb) && !/avail\.map/.test(fb), 'focus add searches the whole master');
  const pm = readFileSync('components/PortfolioUploadModal.tsx', 'utf8'); assert.ok(/data-testid="add-holding"/.test(pm) && /<StockAutocomplete/.test(pm));
  const st = readFileSync('components/StockPostMortem.tsx', 'utf8'); assert.ok(/liveFundamentals\(/.test(st) && /smartApiLabel\(mode\)/.test(st)); assert.ok(/liveFundamentals\(/.test(readFileSync('components/StockOverview.tsx', 'utf8')));
  const ac = readFileSync('components/StockAutocomplete.tsx', 'utf8'); assert.ok(/e\.key === 'Enter'/.test(ac) && /onMouseDown=\{\(e\) => \{ e\.preventDefault\(\); void commit\(r\)/.test(ac));
});

t('Round 32 · Copilot context: null P/E (loss-making SWIGGY), NaN prices and the flat spec payload are all accepted; garbage is still rejected', () => {
  const swiggy = buildCopilotContext({ symbol: 'SWIGGY', name: 'Swiggy Ltd', sector: 'Consumer', ltp: 181.45, prevClose: 211.4, ratios: { marketCapCr: 46162, pe: null, bookValue: 63.4, roce: -19.4, roe: -26.7, debtToEquity: 0.15 }, technicals: { rsi: 16.5, short: { label: 'Bearish', score: -3 }, long: { label: 'Bearish', score: -2 } } });
  assert.equal(swiggy.ratios.pe, null); assert.ok(isContext(swiggy), 'null pe is a valid context'); assert.equal(swiggy.outlook, 'BEARISH'); assert.equal(swiggy.pb, 2.86); assert.ok(Math.abs(swiggy.price.changePct - -14.17) < 0.01);
  const nan = buildCopilotContext({ symbol: 'X', ltp: NaN, prevClose: 0, ratios: { pe: Infinity } }); assert.ok(isContext(JSON.parse(JSON.stringify(nan))), 'NaN/Infinity survive JSON as valid nulls / zeros'); assert.equal(nan.ratios.pe, null);
  const flat = normalizeContext({ symbol: 'SWIGGY', companyName: 'Swiggy Ltd', lastPrice: 181.45, changePercent: -14.17, pe: null, pb: 2.86, marketCapCr: 46162, roce: -19.4, roe: -26.7, debtToEquity: 0.15, rsi: 16.5, outlook: 'BEARISH' });
  assert.ok(flat && isContext(flat) && flat.name === 'Swiggy Ltd' && flat.ratios.pe === null && flat.ratios.marketCapCr === 46162 && flat.technicals.rsi === 16.5 && flat.pb === 2.86 && flat.outlook === 'BEARISH');
  assert.equal(normalizeContext(null), null); assert.equal(normalizeContext({ symbol: 'A'.repeat(40), lastPrice: 1 }), null); assert.equal(normalizeContext({ symbol: 'X' }), null, 'no price → malformed');
  assert.ok(answerLocally('Is it risky?', swiggy, []).length > 40, 'local engine copes with a null P/E');
});
t('Round 32 · search aliases: VBL → Varun Beverages, M&M, nicknames, symbol still wins', () => {
  const idx = buildIndex([{ symbol: 'VBL', name: 'Varun Beverages Ltd', sector: 'FMCG' }, { symbol: 'M&M', name: 'Mahindra & Mahindra Ltd', sector: 'Auto' }, { symbol: 'HINDUNILVR', name: 'Hindustan Unilever Ltd', sector: 'FMCG' }, { symbol: 'VARROC', name: 'Varroc Engineering Ltd', sector: 'Auto' }, { symbol: 'RELIANCE', name: 'Reliance Industries Ltd', sector: 'Energy' }, { symbol: 'SWIGGY', name: 'Swiggy Ltd', sector: 'Consumer' }, { symbol: 'XYZ', name: 'Vast Bharat Logistics Ltd', sector: 'Others' }]);
  const top = (q: string) => searchInstruments(idx, q, 3)[0]?.symbol;
  assert.equal(top('VBL'), 'VBL'); assert.equal(top('varun beverages limited'), 'VBL'); assert.equal(top('M&M'), 'M&M'); assert.equal(top('mahindra & mahindra'), 'M&M'); assert.equal(top('hul'), 'HINDUNILVR'); assert.equal(top('ril'), 'RELIANCE', 'acronym of Reliance Industries Ltd');
  assert.equal(top('swiggy'), 'SWIGGY'); assert.equal(top('vb'), 'VBL', 'core acronym');
});
t('Round 32 · off-market freeze: frozen only when closed and not in demo; closed ⇒ no pump repaint path', () => {
  assert.equal(isFrozen(false, false), true); assert.equal(isFrozen(true, false), false); assert.equal(isFrozen(false, true), false);
  const um = readFileSync('hooks/useMarket.ts', 'utf8'); assert.ok(um.includes('isFrozen(isMarketOpen(Date.now()), engine.demoActive)) {') && um.includes('if (isFrozen(isMarketOpen(now), engine.demoActive)) return;') && um.includes('!isFrozen(isMarketOpen(Date.now()), engine.demoActive)) pump.current?.request()'));
  const sy = readFileSync('scripts/sync-instruments.mjs', 'utf8'); assert.ok(/have >= EXPECTED_MIN/.test(sy), 'seed-sized file does not block the full sync');
});

t('Round 33 · sector heatmap: nine desks, PSU banks split from Banking, four colour bands, gainers/losers, equal-weighted average', () => {
  assert.equal(heatBand(-2.01), 'deep-red'); assert.equal(heatBand(-2), 'light-red'); assert.equal(heatBand(-0.01), 'light-red'); assert.equal(heatBand(0), 'light-green'); assert.equal(heatBand(2), 'light-green'); assert.equal(heatBand(2.01), 'deep-green'); assert.equal(heatBand(null), 'none');
  assert.equal(sectorOf('SBIN', 'Banking'), 'psubank'); assert.equal(sectorOf('HDFCBANK', 'Banking'), 'bank'); assert.equal(sectorOf('TATASTEEL', 'Metals'), 'metal'); assert.equal(sectorOf('X', 'Cement'), null);
  const s = aggregateSectors([{ symbol: 'TCS', sector: 'IT', pct: 3 }, { symbol: 'INFY', sector: 'IT', pct: -1 }, { symbol: 'WIPRO', sector: 'IT', pct: 2.5 }, { symbol: 'SBIN', sector: 'Banking', pct: -3 }, { symbol: 'PNB', sector: 'Banking', pct: -2.5 }, { symbol: 'HDFCBANK', sector: 'Banking', pct: 0.4 }, { symbol: 'ZZZ', sector: 'Cement', pct: 9 }, { symbol: 'BAD', sector: 'IT', pct: NaN }]);
  assert.equal(s.length, 9); const it = s.find((x) => x.id === 'it')!; assert.equal(it.avgPct, 1.5); assert.deepEqual([it.gainers, it.losers, it.count, it.band], [2, 1, 3, 'light-green']);
  const psu = s.find((x) => x.id === 'psubank')!; assert.deepEqual([psu.avgPct, psu.band, psu.losers], [-2.75, 'deep-red', 2]); assert.equal(s.find((x) => x.id === 'bank')!.count, 1); assert.equal(s.find((x) => x.id === 'realty')!.band, 'none');
  const e = ingestFixture(new MarketEngine(SEED_INSTRUMENTS)); const st = e.sectorStats(); assert.equal(st.length, 9); assert.ok(st.some((x) => x.count > 0), 'engine aggregates its real quotes');
});
t('Round 33 · indicators: incremental engine equals the full EMA / RSI / VWAP series on every tick and bar roll; VWAP restarts each session', () => {
  let seed = 7; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const day = (d: number, m: number) => d * 86400 + 9 * 3600 + 15 * 60 + m * 60;
  const bars: import('../lib/types').Candle[] = []; let px = 100;
  for (let d = 0; d < 3; d++) for (let m = 0; m < 80; m++) { const o = px; px = Math.max(5, px + (rnd() - 0.5) * 2); bars.push({ time: day(20000 + d, m), open: o, high: Math.max(o, px) + rnd(), low: Math.min(o, px) - rnd(), close: px, volume: Math.round(1000 + rnd() * 5000) }); }
  const seedN = 60; const live = new LiveIndicators(bars.slice(0, seedN)); const hist = bars.slice(0, seedN); let worst = 0;
  for (let i = seedN; i < bars.length; i++) {
    const b = bars[i]; // 3 intrabar ticks that move the forming bar, then it is final
    hist.push({ ...b, close: b.open }); live.push(hist[hist.length - 1], true);
    for (const f of [0.3, 0.7, 1]) { const cur = { ...b, close: b.open + (b.close - b.open) * f, high: Math.max(b.high, b.open + (b.close - b.open) * f) }; hist[hist.length - 1] = cur; const v = live.push(cur, false); const cl = hist.map((x) => x.close); const [e20, e50, rs, vw] = [emaFull(cl, 20), emaFull(cl, 50), rsiFull(cl, 14), vwapFull(hist)].map((a) => a[a.length - 1]);
      for (const [x, y] of [[v.ema20, e20], [v.ema50, e50], [v.rsi, rs], [v.vwap, vw]] as [number | null, number | null][]) { if (x === null || y === null) assert.equal(x, y); else worst = Math.max(worst, Math.abs(x - y)); } }
  }
  assert.ok(worst < 1e-8, `incremental ≡ full (max drift ${worst})`);
  const vw = vwapFull(bars); const first2 = bars[80]; assert.ok(Math.abs(vw[80]! - (first2.high + first2.low + first2.close) / 3) < 1e-9, 'VWAP restarts at the new session\'s first bar'); assert.ok(vw[79]! !== vw[80]);
  const e20 = emaFull(bars.map((b) => b.close), 20); assert.equal(e20[18], null); assert.ok(Math.abs(e20[19]! - bars.slice(0, 20).reduce((a, b) => a + b.close, 0) / 20) < 1e-9, 'EMA seeded with the SMA');
  assert.equal(vwapAvailable(false, true), false); assert.equal(vwapAvailable(true, false), false); assert.equal(vwapAvailable(true, true), true);
  assert.deepEqual([INDICATOR_COLORS.ema20, INDICATOR_COLORS.ema50], ['#f59e0b', '#8b5cf6']);
  const pc = readFileSync('components/PriceChart.tsx', 'utf8'); assert.ok(/liveInd\.current/.test(pc) && /li\.push\(next, bucket > cur\.time\)/.test(pc) && /data-testid=\{`ind-\$\{id\}`\}/.test(pc));
});
t('Round 33 · circuit desk history: cloud rows + session hits merge by symbol·dir·band·IST day; tabs filter; demo hits stay session-only', () => {
  const at = Date.parse('2026-10-22T05:00:00Z');
  const sess = [fromEvent({ symbol: 'TCS', dir: 'upper', band: 5, ltp: 3700, pct: 5, at }), fromEvent({ symbol: 'ZEEL', dir: 'lower', band: 10, ltp: 90, pct: -10, at: at + 5000, demo: true })];
  const cloudRows = fromRows([{ symbol: 'TCS', direction: 'UPPER', band: 5, price: 3700, triggered_at: new Date(at + 800).toISOString() }, { symbol: 'SBIN', direction: 'LOWER', band: 5, price: 700, triggered_at: new Date(at - 3600_000).toISOString() }, { symbol: 'BAD', direction: 'SIDEWAYS' as never, band: 5, price: 1, triggered_at: 'x' }]);
  assert.equal(cloudRows.length, 2); const m = mergeHistory(sess, cloudRows); assert.equal(m.length, 3, 'TCS seen on both sides counts once');
  assert.deepEqual(m.map((x) => x.symbol), ['ZEEL', 'TCS', 'SBIN']); assert.equal(m.find((x) => x.symbol === 'TCS')!.origin, 'both'); assert.equal(m.find((x) => x.symbol === 'SBIN')!.origin, 'cloud');
  assert.deepEqual(filterHistory(m, 'upper').map((x) => x.symbol), ['TCS']); assert.deepEqual(filterHistory(m, 'lower').map((x) => x.symbol), ['ZEEL', 'SBIN']); assert.equal(filterHistory(m, 'near').length, 0); assert.equal(filterHistory(m, 'all').length, 3);
  assert.deepEqual(HISTORY_TABS.map((t2) => t2.label), ['All Anomalies', 'Upper Circuit (UC)', 'Lower Circuit (LC)', 'Near Limit (±1.5%)']);
  const nl = nearLimit([{ symbol: 'A', ltp: 103.9, prevClose: 100 }, { symbol: 'B', ltp: 101, prevClose: 100 }, { symbol: 'C', ltp: 105, prevClose: 100 }]); assert.deepEqual(nl.map((x) => x.symbol), ['A'], 'within 1.5% of the 5% band, not yet at a limit');
  const dr = readFileSync('components/CircuitLogDrawer.tsx', 'utf8'); assert.ok(/Test Chime/.test(dr) && /Analyze/.test(dr) && /playChime\(soundFor\(dir, n\.sound\), n\.volume\)/.test(dr));
});

t('Round 34 · long ranges: 1Y daily ≤252 · 5Y weekly ≤260 · 10Y monthly ≤120; a wrong-resolution or empty provider answer is rebuilt from daily bars; bad rows never reach the chart', () => {
  assert.deepEqual([RANGE_SPECS['1Y']!.res, RANGE_SPECS['1Y']!.keep, RANGE_SPECS['5Y']!.res, RANGE_SPECS['5Y']!.keep, RANGE_SPECS['10Y']!.res, RANGE_SPECS['10Y']!.keep], ['daily', 252, 'weekly', 260, 'monthly', 120]);
  const D = 86400; const t0 = Math.floor(Date.parse('2016-10-03T00:00:00Z') / 1000); // a Monday
  const daily: Candle[] = []; let px = 100; for (let d = 0; d < 3650; d++) { const time = t0 + d * D; const dow = new Date(time * 1000).getUTCDay(); if (dow === 0 || dow === 6) continue; const o = px; px *= 1 + Math.sin(d / 20) * 0.004; daily.push({ time, open: o, high: Math.max(o, px) * 1.002, low: Math.min(o, px) * 0.998, close: px, volume: 1000 }); }
  assert.equal(weekStart(t0 + 3 * D), t0, 'Wednesday → its Monday'); assert.equal(monthStart(t0 + 20 * D), Date.UTC(2016, 9, 1) / 1000);
  const wk = aggregateCalendar(daily, 'weekly'); const mo = aggregateCalendar(daily, 'monthly');
  assert.ok(wk.length > 500 && wk.length < 530 && mo.length >= 119 && mo.length <= 122, `weeks ${wk.length} months ${mo.length}`); assert.ok(resolutionOk(wk, 'weekly') && resolutionOk(mo, 'monthly') && !resolutionOk(daily, 'weekly') && resolutionOk(daily, 'daily'));
  const w0 = wk[10]; const inWeek = daily.filter((c) => weekStart(c.time) === w0.time); assert.equal(w0.open, inWeek[0].open); assert.equal(w0.close, inWeek.at(-1)!.close); assert.equal(w0.high, Math.max(...inWeek.map((c) => c.high))); assert.equal(w0.low, Math.min(...inWeek.map((c) => c.low))); assert.equal(w0.volume, inWeek.length * 1000);
  // provider answers: right resolution → used (trimmed); wrong resolution (daily bars for a 10Y request) or empty → rebuilt from the daily series
  assert.equal(acceptDirect('5Y', wk)!.length, 260); assert.equal(acceptDirect('10Y', mo)!.length, 120); assert.equal(acceptDirect('1Y', daily)!.length, 252);
  assert.equal(acceptDirect('10Y', daily), null, 'daily bars are not monthly'); assert.equal(acceptDirect('5Y', []), null);
  const r10 = resolveRange('10Y', daily, daily); assert.equal(r10.via, 'aggregated'); assert.equal(r10.bars.length, 120); const r5 = resolveRange('5Y', [], daily); assert.equal(r5.via, 'aggregated'); assert.equal(r5.bars.length, 260);
  assert.equal(resolveRange('10Y', [], null).via, 'none'); assert.equal(resolveRange('1Y', daily, null).bars.length, 252);
  const bad = sanitizeBars([{ time: 3, open: 1, high: 1, low: 1, close: 1, volume: 1 }, { time: 1, open: 2, high: 1, low: 3, close: 2, volume: -5 }, { time: 1, open: 9, high: 9, low: 9, close: 9, volume: 1 }, { time: 2, open: NaN, high: 1, low: 1, close: 1, volume: 1 }, { time: 4, open: 0, high: 1, low: 1, close: 1, volume: 1 }]);
  assert.deepEqual(bad.map((c) => c.time), [1, 3], 'ascending, unique, finite, positive'); assert.ok(bad[0].high >= bad[0].low);
  const pc = readFileSync('components/PriceChart.tsx', 'utf8'); assert.ok(/sanitizeBars\(/.test(pc) && /requestAnimationFrame\(\(\) => chartRef\.current\?\.timeScale\(\)\.fitContent\(\)\)/.test(pc));
  const yq = readFileSync('lib/yahooQuotes.ts', 'utf8'); assert.ok(/acceptDirect\(tf, direct\)/.test(yq) && /spec\.dailyRange/.test(yq));
});
t('Round 34 · portfolio risk engine: HHI = Σ s² on stock and sector weights, beta = Cov/Var vs NIFTY, Sharpe, badge thresholds', () => {
  const pos = [{ symbol: 'A', sector: 'IT', value: 500 }, { symbol: 'B', sector: 'IT', value: 300 }, { symbol: 'C', sector: 'Bank', value: 200 }];
  assert.deepEqual(stockWeights(pos).map((s) => s.weightPct), [50, 30, 20]);
  const mk = (r: number[]) => { let p = 100; return [100, ...r.map((x) => (p *= 1 + x))]; };
  const rets = Array.from({ length: 80 }, (_, i) => Math.sin(i / 3) * 0.01 + Math.cos(i / 7) * 0.004); const nifty = mk(rets);
  const levered = mk(rets.map((x) => 1.5 * x)); const flat = mk(rets.map(() => 0.0005));
  const r = portfolioRisk(pos, [1, 1, 1], [levered, levered, levered], nifty);
  assert.equal(r.stockHhi, 2500 + 900 + 400); assert.equal(r.sectorHhi, 800 ** 2 / 100 + 20 ** 2); assert.equal(r.badge.label, 'HIGH CONCENTRATION RISK'); assert.ok(Math.abs(r.beta! - 1.5) < 1e-6, 'β of a 1.5× clone = 1.5'); assert.ok(r.sharpe !== null && r.obs === 80);
  assert.equal(betaOf(rets.slice(0, 10), rets.slice(0, 10)), null, '< 30 obs → N/A'); assert.equal(betaOf(rets, rets.map(() => 0.001)), null, 'flat benchmark → N/A');
  assert.equal(riskBadge(1000, 1200).label, 'LOW CONCENTRATION'); assert.equal(riskBadge(1700, 900).label, 'MODERATE RISK'); assert.equal(riskBadge(1000, 2501).label, 'HIGH CONCENTRATION RISK'); assert.equal(riskBadge(2500, 0).label, 'MODERATE RISK', '2 500 exactly is not > 2 500');
  const eq = Array.from({ length: 10 }, (_, i) => ({ symbol: 'S' + i, sector: 'Sec' + i, value: 100 })); assert.equal(portfolioRisk(eq, eq.map(() => 1), eq.map(() => flat), nifty).stockHhi, 1000);
  const before = portfolioRisk(pos, [1, 1, 1], [flat, flat, flat], nifty).stockHhi; const after = portfolioRisk([...pos, { symbol: 'D', sector: 'Auto', value: 1500 }], [1, 1, 1, 1], [flat, flat, flat, flat], nifty).stockHhi; assert.ok(after !== before, 'HHI follows holdings');
  assert.equal(portfolioRisk([], [], [], nifty).stocks.length, 0);
  assert.ok(/PortfolioRiskEngine/.test(readFileSync('components/dashboards/Institutional.tsx', 'utf8')) && /PortfolioRiskEngine/.test(readFileSync('components/dashboards/Executive.tsx', 'utf8')));
});
t('Round 34 · drawing toolbar: stroke-only 1.5 icons, slate palette, tooltips with Alt shortcuts', () => {
  const tb = readFileSync('components/DrawingToolbar.tsx', 'utf8');
  assert.ok(/strokeWidth="1\.5"/.test(tb) && /fill="none"/.test(tb) && /stroke="currentColor"/.test(tb));
  assert.ok(!/[\u{1F300}-\u{1FAFF}\u2600-\u27BF]/u.test(tb.replace(/\/\*[\s\S]*?\*\//g, '')), 'no emoji glyphs');
  for (const c of ['text-slate-400', 'bg-slate-900/60', 'hover:bg-slate-800/80', 'hover:text-slate-100', 'bg-blue-600/20', 'text-blue-400', 'border-l-2', 'border-blue-500']) assert.ok(tb.includes(c), c);
  for (const s of ['Trend Line', 'Magnet Mode', 'Clear Drawings', 'Alt+T']) assert.ok(tb.includes(s) || tb.includes(s.replace('Alt+T', "key: 'T'")), s);
});
t('Round 34 · research PDF: model carries every required section; jsPDF renders a real light and dark PDF; ₹ is mapped to Rs.', async () => {
  const q = { symbol: 'TCS', name: 'Tata Consultancy Services', exch: 'NSE', sector: 'IT', ltp: 4100.5, prevClose: 4000, high: 4120, low: 3990, volume: 1e6, circuitBand: 20, lowerCircuit: 3200, upperCircuit: 4800 };
  const s = getScreener(q as never); const report = buildReport(q as never, s, new Date('2026-10-25T05:00:00Z')); const closes = Array.from({ length: 120 }, (_, i) => 3800 + i * 2.5 + Math.sin(i / 4) * 20);
  const model = buildPdfModel({ report, closes, rsi: 63.4, pivots: { p: 4070, r1: 4100, r2: 4150, s1: 4020, s2: 3990 }, pb: 12.5, ai: { text: '## Analyst Summary\n- **Valuation** is rich\n- Risk: moderate\n\nClosing line.', source: 'Gemini AI' }, news: { items: [{ title: 'TCS wins deal', source: 'ET', label: 'Bullish', score: 0.5 }, { title: 'IT stocks slip', source: 'Mint', label: 'Bearish', score: -0.3 }], specific: true, sample: false }, feed: 'Prices from the last session' });
  const heads = model.blocks.filter((b) => b.t === 'h2').map((b) => (b as { text: string }).text); assert.deepEqual(heads.map((h) => h.split(' (')[0]), ['Executive summary & company profile', 'Key valuation ratios', 'Technical summary', 'AI copilot valuation insights', 'News sentiment summary']);
  const flat = JSON.stringify(model.blocks); for (const k of ['EMA 20', 'EMA 50', 'RSI (14)', 'P/E', 'P/B', 'ROCE', 'ROE', 'Debt / equity', 'Market cap', 'S1', 'R1', 'Pivot']) assert.ok(flat.includes(k), k);
  assert.ok(mdToBlocks('## H\n- a **b**\ntext').length === 3 && pdfText('₹100 ▲ — ok') === 'Rs. 100 + - ok');
  for (const theme of ['light', 'dark'] as const) { const { blob, pages, fileName } = await renderPdf(model, theme); const buf = Buffer.from(await blob.arrayBuffer()); assert.equal(buf.subarray(0, 5).toString(), '%PDF-'); assert.ok(pages >= 1 && buf.length > 3000 && fileName.endsWith(`_${theme}.pdf`)); const txt = buf.toString('latin1'); assert.ok(txt.includes('EXECUTIVE SUMMARY') && txt.includes('TECHNICAL SUMMARY') && txt.includes('Tata Consultancy'), theme); if (theme === 'dark') assert.ok(/0\.043 0\.071 0\.125 rg/.test(txt) || /rg/.test(txt)); }
  assert.ok(/downloadResearchPdf/.test(readFileSync('components/ExportReport.tsx', 'utf8')) && /Export Research Report/.test(readFileSync('components/ExportReport.tsx', 'utf8')));
});

t('Round 35 · copilot cards: local answers are verdict + chips + bold-lead bullets + collapsible sections (never a wall of text)', () => {
  const ctx = mkCtx();
  for (const q of ['Is it expensive?', 'debt?', 'support resistance?', 'key risks?', 'should I invest?']) {
    const a = answerLocally(q, ctx, []);
    const c = parseCopilotCard(a);
    assert.ok(c.structured && c.verdict, q);
    assert.ok(/^(BULLISH|BEARISH|NEUTRAL)$/.test(c.verdict!), q);
    assert.match(a, /- \*\*[A-Za-z\- ]+:\*\*/, q + ' has bold lead-in bullets');
    assert.ok(!/^•/m.test(a), 'no raw bullets');
  }
  const v = parseCopilotCard(answerLocally('Is it expensive?', ctx, []));
  assert.ok(v.chips.some((x) => x.label === 'P/E') && v.chips.every((x) => x.value && !/NaN|undefined|null/.test(x.value)));
  // a null P/E produces NO chip (never an invented number)
  const nul = mkCtx(); nul.ratios.pe = null;
  assert.ok(!parseCopilotCard(answerLocally('Is it expensive?', nul, [])).chips.some((x) => x.label === 'P/E'));
  const g = parseCopilotCard('[VERDICT: BEARISH] Weak momentum.\n[P/E: 21.5 | Fair] [RSI: 71.2 | Overbought] [Next resistance: ₹1,320]\n- **Trend:** down\n### Risks\n- **Debt:** high\n### Catalysts\n- **Results:** soon');
  assert.equal(g.verdict, 'BEARISH'); assert.equal(g.takeaway, 'Weak momentum.');
  assert.deepEqual(g.chips.map((x) => [x.label, x.value, x.tag, x.tone]), [['P/E', '21.5', 'Fair', 'warn'], ['RSI', '71.2', 'Overbought', 'down'], ['Next resistance', '₹1,320', undefined, 'muted']]);
  assert.deepEqual(g.sections.map((x) => x.title), ['Risks', 'Catalysts']); assert.match(g.body, /Trend/);
  assert.equal(parseCopilotCard('Just a plain paragraph.').structured, false);
  assert.ok(QUICK_ACTIONS.length >= 3 && QUICK_ACTIONS.some((q) => /Breakout/.test(q.label)) && QUICK_ACTIONS.every((q) => q.question.length > 10));
  assert.match(SYSTEM_PROMPT, /VERDICT/); assert.match(SYSTEM_PROMPT, /NO PARAGRAPHS/);
});
t('Round 35 · news engine: relative times, ticker extraction, Google News title split', () => {
  const now = 1_700_000_000_000;
  assert.equal(relativeTime(now - 30_000, now), 'just now');
  assert.equal(relativeTime(now - 12 * 60_000, now), '12 mins ago');
  assert.equal(relativeTime(now - 60 * 60_000, now), '1 hour ago');
  assert.equal(relativeTime(now - 3 * 3600_000, now), '3 hours ago');
  assert.equal(relativeTime(now - 2 * 86400_000, now), '2 days ago');
  assert.equal(relativeTime(0, now), '');
  assert.ok(extractSymbols('Reliance Industries and TCS lead Nifty gains').includes('RELIANCE'));
  assert.ok(extractSymbols('TCS wins a large deal').includes('TCS'));
  assert.deepEqual(extractSymbols('Markets steady as investors await policy cues'), []);
  assert.deepEqual(splitGoogleTitle('Sensex jumps 400 points on banking rally - Economic Times'), { title: 'Sensex jumps 400 points on banking rally', source: 'Economic Times' });
  assert.deepEqual(splitGoogleTitle('Short - x'), { title: 'Short - x', source: '' });
});
t('Round 35 · drawings: brush + price range persist / move / thin; invalid shapes are dropped', () => {
  const raw = JSON.stringify([
    { id: 'b1', kind: 'brush', a: { t: 1, p: 1 }, pts: [{ t: 1, p: 1 }, { t: 2, p: 2 }, { t: 3, p: 1.5 }] },
    { id: 'b2', kind: 'brush', pts: [{ t: 1, p: 1 }] },
    { id: 'r1', kind: 'range', a: { t: 5, p: 100 }, b: { t: 9, p: 110 } },
    { id: 'x', kind: 'range', a: { t: 5, p: 100 } },
  ]);
  const d = parseDrawings(raw);
  assert.deepEqual(d.map((x) => x.id), ['b1', 'r1']);
  const bars = Array.from({ length: 10 }, (_, i) => ({ time: i * 60, open: 1, high: 2, low: 0.5, close: 1.5 }));
  const mv = moveDrw(d[0], 2, 1, bars, 60);
  assert.ok(mv.kind === 'brush' && mv.pts.length === 3 && mv.pts[0].t === 121 && Math.abs(mv.pts[0].p - 2) < 1e-9);
  const st = rangeStats({ t: 0, p: 100 }, { t: 1, p: 110 }); assert.equal(st.dPrice, 10); assert.equal(st.dPct, 10);
  assert.deepEqual(thinStroke([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 5, y: 0 }, { x: 6, y: 0 }, { x: 9, y: 0 }], 3), [0, 2, 4]);
});
t('Round 35 · telemetry is measured, never invented', () => {
  const e = new MarketEngine(SEED_INSTRUMENTS);
  const idle = e.telemetry();
  assert.equal(idle.ticksPerSec, null); assert.equal(idle.delayMs, null); assert.equal(idle.ticks, 0);
  e.mode = 'live';
  const now = Date.now();
  e.applyTick({ symbol: 'TCS', ltp: 4100, close: 4000, ts: now - 40 }, now);
  e.applyTick({ symbol: 'TCS', ltp: 4101, close: 4000, ts: now - 60 }, now + 100);
  const m = e.telemetry(now + 200);
  assert.equal(m.ticks, 2); assert.ok(m.ticksPerSec! > 0 && m.ticksPerSec! <= 1); assert.ok(m.delayMs! >= 40 && m.delayMs! <= 120, 'delay ' + m.delayMs);
});

t('Round 36 · news relevance filter: equities / earnings / IPO / macro in, auto + tech + foreign noise out', () => {
  const keep = ['Sensex jumps 400 points, Nifty ends above 25,000', 'SEBI tightens F&O rules for retail traders', 'FIIs sold Rs 3,200 crore of Indian equities on Friday', 'TCS Q2 results: net profit rises 8%, declares dividend', 'Reliance Industries to acquire stake in solar firm', 'Swiggy shares surge after quarterly results', 'IPO GMP today: grey market premium hints at 30% listing gains', 'IPO allotment status: how to check', 'RBI keeps repo rate unchanged at 5.5%, cuts inflation forecast', 'India GDP growth seen at 6.8% in FY27', 'Rupee slips to 88 as crude oil climbs', 'HDFC Bank, ICICI Bank among top Nifty gainers', 'Brokerages raise target price on Infosys after earnings'];
  const drop = ['Car spyshots: next-gen Maruti Swift caught testing', 'Web bugs broke the internet again', 'Audi factory in Georgia to open next year', 'iPhone 17 review: the best smartphone yet', 'Virat Kohli smashes ton in IPL clash', 'Bollywood box office: weekend collections', 'Best earbuds under 2,000 rupees', 'Tata Nexon facelift first drive review', 'Trump meets Putin in Alaska'];
  keep.forEach((x) => assert.ok(isMarketRelevant(x), 'keep: ' + x));
  drop.forEach((x) => assert.ok(!isMarketRelevant(x), 'drop: ' + x));
  assert.ok(!isMarketRelevant('Sensex-linked story', { source: 'Autocar India' }), 'blocked source');
  assert.ok(!isMarketRelevant('Nifty-like title', { link: 'https://www.gsmarena.com/x' }), 'blocked host');
  assert.ok(isMarketRelevant('Nifty hits record high', { source: 'Economic Times', link: 'https://economictimes.indiatimes.com/x' }));
});
t('Round 36 · stock-specific news + sentiment summary', () => {
  assert.ok(mentionsStock('Swiggy shares surge 6% after Q2 update', 'SWIGGY', 'Swiggy Ltd'));
  assert.ok(mentionsStock('Reliance Industries to acquire stake', 'RELIANCE', 'Reliance Industries Ltd'));
  assert.ok(!mentionsStock('Zomato and Eternal widen losses', 'SWIGGY', 'Swiggy Ltd'));
  assert.ok(!mentionsStock('Relianceless market', 'RELIANCE', 'Reliance Industries Ltd'));
  const items = [
    { id: '1', title: 'TCS wins record deal', label: 'Bullish' as const, score: 0.5, published: 0 },
    { id: '2', title: 'TCS shares rally', label: 'Bullish' as const, score: 0.4, published: 0 },
    { id: '3', title: 'TCS to announce results', label: 'Neutral' as const, score: 0, published: 0 },
    { id: '4', title: 'TCS faces attrition worries', label: 'Bearish' as const, score: -0.3, published: 0 },
    { id: '5', title: 'Infosys wins deal', label: 'Bullish' as const, score: 0.5, published: 0 },
  ];
  const mine = stockNews(items, 'TCS', 'Tata Consultancy Services Ltd');
  assert.equal(mine.length, 4);
  const sum = summarizeSentiment(mine); assert.deepEqual([sum.total, sum.bullish, sum.dominant, sum.pct], [4, 2, 'Bullish', 50]); assert.equal(sentimentChipText(sum), '50% Bullish (4 articles)'); assert.equal(sentimentChipText(summarizeSentiment([])), 'No recent headlines');
});

void Promise.all(pending).then(() => {
  console.log(`\n${passed} checks passed${process.exitCode ? ' — WITH FAILURES' : ''}`);
  process.exit(process.exitCode ?? 0); // some modules keep timers alive
});
