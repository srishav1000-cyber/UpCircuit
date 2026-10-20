// REAL fundamentals from Yahoo Finance (unofficial endpoints — no API key, but quoteSummary needs a cookie + crumb).
// Pure parsers + a fetcher (testable against a mock via YAHOO_BASE / YAHOO_COOKIE_URL) and `mergeLive`, which overlays the real
// numbers on the quote-only Screener from lib/screener.ts field by field; missing fields stay null (rendered N/A).
import type { QuarterRow, Screener } from './screener';
import { toYahooSymbol } from './yahoo';

export interface LiveFundamentals {
  yahooSymbol: string;
  fetchedAt: number;
  marketCapCr?: number;
  pe?: number;
  bookValue?: number;
  dividendYield?: number;
  roe?: number;
  roce?: number;
  eps?: number;
  high52?: number;
  low52?: number;
  debtToEquity?: number;
  /** promoters ≈ Yahoo "insiders"; institutions = FII + DII combined (Yahoo does not split them) */
  holding?: { promoters: number; institutions: number };
  quarters: QuarterRow[];
}

const CR = 1e7; // ₹ → ₹ Cr
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const rnd = (n: number, dp = 2) => Math.round(n * 10 ** dp) / 10 ** dp;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined => (v && typeof v === 'object' ? (v as Obj) : undefined);
/** Yahoo wraps numbers as `{ raw, fmt }`; accept both shapes. */
export const raw = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : obj(v)?.raw;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
};
const posv = (n: number | undefined) => (n !== undefined && n > 0 ? n : undefined);

function labelOf(d: string | number): string | null {
  const dt = typeof d === 'number' ? new Date(d * 1000) : /^\d{4}-\d{2}-\d{2}/.test(d) ? new Date(`${d.slice(0, 10)}T00:00:00Z`) : null;
  if (!dt || Number.isNaN(dt.getTime())) return null;
  return `${MONTHS[dt.getUTCMonth()]} ${dt.getUTCFullYear()}`;
}

interface RawQuarter { key: number; label: string; rev?: number; ebitda?: number; opInc?: number; exp?: number; ni?: number; eps?: number }

/** Raw (₹) per-quarter rows → ₹ Cr QuarterRows: latest ≤5, oldest → newest. Rows without revenue or net income are dropped. */
export function buildQuarters(rows: RawQuarter[]): QuarterRow[] {
  return rows
    .filter((r) => r.rev !== undefined && r.rev > 0 && r.ni !== undefined)
    .sort((a, b) => a.key - b.key)
    .slice(-5)
    .map((r) => {
      const sales = r.rev! / CR;
      const op = (r.ebitda ?? r.opInc ?? (r.exp !== undefined ? r.rev! - r.exp : undefined)) as number | undefined;
      const opCr = op !== undefined ? op / CR : sales - (r.exp ?? sales) / CR;
      return { label: r.label, sales: rnd(sales, 1), expenses: rnd(sales - opCr, 1), operatingProfit: rnd(opCr, 1), opmPct: rnd(sales ? (opCr / sales) * 100 : 0, 1), netProfit: rnd(r.ni! / CR, 1), eps: rnd(r.eps ?? 0) };
    });
}

/** quoteSummary → ratios (+ quarters from incomeStatementHistoryQuarterly, which Yahoo has thinned out — timeseries is preferred). */
export function parseQuoteSummary(body: unknown): Omit<LiveFundamentals, 'yahooSymbol' | 'fetchedAt'> & { currency?: string } {
  const r = obj((obj(obj(obj(body)?.quoteSummary)?.result as unknown[])?.[0] ?? (obj(obj(body)?.quoteSummary)?.result as unknown[] | undefined)?.[0]));
  const sd = obj(r?.summaryDetail), ks = obj(r?.defaultKeyStatistics), fd = obj(r?.financialData), pr = obj(r?.price);
  const mcap = posv(raw(sd?.marketCap) ?? raw(pr?.marketCap));
  const dy = raw(sd?.dividendYield) ?? raw(sd?.trailingAnnualDividendYield);
  const roe = raw(fd?.returnOnEquity);
  const de = raw(fd?.debtToEquity);
  const insiders = raw(ks?.heldPercentInsiders);
  const inst = raw(ks?.heldPercentInstitutions);
  const qs = ((obj(r?.incomeStatementHistoryQuarterly)?.incomeStatementHistory as unknown[]) ?? []).flatMap((x) => {
    const o = obj(x);
    const end = raw(o?.endDate);
    const label = end !== undefined ? labelOf(end) : null;
    return label && end !== undefined ? [{ key: end, label, rev: raw(o?.totalRevenue), ebitda: raw(o?.ebitda), opInc: raw(o?.operatingIncome) ?? raw(o?.ebit), exp: raw(o?.totalOperatingExpenses), ni: raw(o?.netIncome) }] : [];
  });
  const cur = (typeof pr?.currency === 'string' ? pr.currency : undefined) as string | undefined;
  const fcur = (typeof fd?.financialCurrency === 'string' ? fd.financialCurrency : typeof pr?.financialCurrency === 'string' ? pr.financialCurrency : undefined) as string | undefined;
  return {
    currency: fcur ?? cur,
    marketCapCr: mcap !== undefined ? mcap / CR : undefined,
    pe: posv(raw(sd?.trailingPE) ?? raw(ks?.trailingPE)),
    bookValue: posv(raw(ks?.bookValue)),
    dividendYield: dy !== undefined && dy >= 0 ? rnd(dy < 1 ? dy * 100 : dy) : undefined,
    roe: roe !== undefined ? rnd(roe * 100, 1) : undefined,
    eps: raw(ks?.trailingEps),
    high52: posv(raw(sd?.fiftyTwoWeekHigh)),
    low52: posv(raw(sd?.fiftyTwoWeekLow)),
    debtToEquity: de !== undefined && de >= 0 ? rnd(de / 100) : undefined, // Yahoo reports D/E in percent
    holding: insiders !== undefined && inst !== undefined ? { promoters: Math.min(100, Math.max(0, insiders * 100)), institutions: Math.min(100, Math.max(0, inst * 100)) } : undefined,
    quarters: buildQuarters(qs),
  };
}

export type Series = Record<string, { key: number; label: string; v: number }[]>;
/** fundamentals-timeseries (merge=false) → { type: [{date, value}] }. */
export function parseTimeseries(body: unknown): Series {
  const out: Series = {};
  const res = obj(obj(body)?.timeseries)?.result;
  if (!Array.isArray(res)) return out;
  for (const e of res) {
    const o = obj(e);
    const type = (obj(o?.meta)?.type as unknown[] | undefined)?.[0];
    if (typeof type !== 'string' || !Array.isArray(o?.[type])) continue;
    out[type] = (o![type] as unknown[]).flatMap((a) => {
      const x = obj(a);
      const d = x?.asOfDate;
      const v = raw(x?.reportedValue);
      const label = typeof d === 'string' ? labelOf(d) : null;
      return label && v !== undefined ? [{ key: Date.parse(`${(d as string).slice(0, 10)}T00:00:00Z`) / 1000, label, v }] : [];
    });
  }
  return out;
}

/** Quarterly rows + an annual ROCE (EBIT ÷ capital employed = total assets − current liabilities) from timeseries. */
export function fromTimeseries(s: Series): { quarters: QuarterRow[]; roce?: number } {
  const by = new Map<number, RawQuarter>();
  const put = (type: string, f: (q: RawQuarter, v: number) => void) => {
    for (const p of s[type] ?? []) {
      const q = by.get(p.key) ?? { key: p.key, label: p.label };
      f(q, p.v);
      by.set(p.key, q);
    }
  };
  put('quarterlyTotalRevenue', (q, v) => (q.rev = v));
  put('quarterlyEBITDA', (q, v) => (q.ebitda = v));
  put('quarterlyOperatingIncome', (q, v) => (q.opInc = v));
  put('quarterlyTotalExpenses', (q, v) => (q.exp = v));
  put('quarterlyNetIncome', (q, v) => (q.ni = v));
  put('quarterlyDilutedEPS', (q, v) => (q.eps = v));
  const last = (t: string) => (s[t] ?? []).slice().sort((a, b) => a.key - b.key).at(-1)?.v;
  const ebit = last('annualEBIT');
  const ta = last('annualTotalAssets');
  const cl = last('annualCurrentLiabilities');
  const ce = ta !== undefined && cl !== undefined ? ta - cl : undefined;
  return { quarters: buildQuarters([...by.values()]), roce: ebit !== undefined && ce !== undefined && ce > 0 ? rnd((ebit / ce) * 100, 1) : undefined };
}

/* ───────────── fetching (server only) ───────────── */

const HEADERS = { 'User-Agent': 'Mozilla/5.0 (compatible; UpCircuit)', Accept: 'application/json,text/plain,*/*' };
const MODULES = 'summaryDetail,defaultKeyStatistics,financialData,price,incomeStatementHistory,incomeStatementHistoryQuarterly';
const TS_TYPES = 'quarterlyTotalRevenue,quarterlyTotalExpenses,quarterlyEBITDA,quarterlyOperatingIncome,quarterlyNetIncome,quarterlyDilutedEPS,annualEBIT,annualTotalAssets,annualCurrentLiabilities';

export interface Session { cookie: string; crumb: string; exp: number }
let session: Session | null = null;

export async function getSession(base: string, cookieUrl: string, force = false, timeoutMs = 6000): Promise<Session | null> {
  if (!force && session && session.exp > Date.now()) return session;
  try {
    const c = await fetch(cookieUrl, { headers: HEADERS, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    const sc = typeof c.headers.getSetCookie === 'function' ? c.headers.getSetCookie() : [c.headers.get('set-cookie') ?? ''];
    const cookie = sc.map((x) => x.split(';')[0]).filter(Boolean).join('; ');
    const cr = await fetch(`${base}/v1/test/getcrumb`, { headers: { ...HEADERS, Cookie: cookie }, signal: AbortSignal.timeout(timeoutMs) });
    const crumb = cr.ok ? (await cr.text()).trim() : '';
    if (!crumb || crumb.length > 64 || /[<{]/.test(crumb)) return null;
    return (session = { cookie, crumb, exp: Date.now() + 50 * 60_000 });
  } catch {
    return null;
  }
}

async function getJson(url: string, s: Session, timeoutMs: number): Promise<{ status: number; body?: unknown }> {
  try {
    const res = await fetch(url, { headers: { ...HEADERS, Cookie: s.cookie }, signal: AbortSignal.timeout(timeoutMs) });
    return res.ok ? { status: res.status, body: await res.json() } : { status: res.status };
  } catch {
    return { status: 0 };
  }
}

async function fetchOne(ys: string, base: string, cookieUrl: string, timeoutMs: number): Promise<LiveFundamentals | null> {
  let s = await getSession(base, cookieUrl, false, timeoutMs);
  if (!s) return null;
  const now = Math.floor(Date.now() / 1000);
  const urls = (k: Session) => [
    `${base}/v10/finance/quoteSummary/${ys}?modules=${MODULES}&crumb=${encodeURIComponent(k.crumb)}`,
    `${base}/ws/fundamentals-timeseries/v1/finance/timeseries/${ys}?type=${TS_TYPES}&period1=${now - 3 * 365 * 86400}&period2=${now}&merge=false&crumb=${encodeURIComponent(k.crumb)}`,
  ];
  let [qs, ts] = await Promise.all(urls(s).map((u) => getJson(u, s!, timeoutMs)));
  if (qs.status === 401 || qs.status === 403 || ts.status === 401) {
    // stale crumb → one refresh
    s = await getSession(base, cookieUrl, true, timeoutMs);
    if (!s) return null;
    [qs, ts] = await Promise.all(urls(s).map((u) => getJson(u, s!, timeoutMs)));
  }
  const sum = qs.body ? parseQuoteSummary(qs.body) : undefined;
  const t = ts.body ? fromTimeseries(parseTimeseries(ts.body)) : undefined;
  const inrOk = !sum?.currency || sum.currency === 'INR';
  const quarters = inrOk ? (t && t.quarters.length ? t.quarters : sum?.quarters ?? []) : [];
  const out: LiveFundamentals = { yahooSymbol: ys, fetchedAt: Date.now(), marketCapCr: sum?.marketCapCr, pe: sum?.pe, bookValue: sum?.bookValue, dividendYield: sum?.dividendYield, roe: sum?.roe, roce: t?.roce, eps: sum?.eps, high52: sum?.high52, low52: sum?.low52, debtToEquity: sum?.debtToEquity, holding: sum?.holding, quarters };
  const has = out.marketCapCr !== undefined || out.pe !== undefined || out.eps !== undefined || quarters.length > 0;
  return has ? out : null;
}

/** NSE first (`.NS`), then the other exchange (`.BO`) when the first has nothing. Returns null when Yahoo has no data / is unreachable. */
export async function fetchLiveFundamentals(symbol: string, exch: 'NSE' | 'BSE' = 'NSE', base = process.env.YAHOO_BASE || 'https://query1.finance.yahoo.com', cookieUrl = process.env.YAHOO_COOKIE_URL || 'https://fc.yahoo.com', timeoutMs = 7000): Promise<LiveFundamentals | null> {
  for (const e of exch === 'NSE' ? (['NSE', 'BSE'] as const) : (['BSE', 'NSE'] as const)) {
    const r = await fetchOne(toYahooSymbol(symbol, e), base, cookieUrl, timeoutMs);
    if (r) return r;
  }
  return null;
}

/* ───────────── merge real over estimated ───────────── */

const fin = (n: number | undefined): n is number => n !== undefined && Number.isFinite(n);

/** Overlay the provider's real numbers on the quote-only Screener, per field. Anything the provider lacks stays null (N/A) and is listed in `source.na`. */
export function mergeLive(base: Screener, live: LiveFundamentals | null | undefined, ltp: number): Screener {
  if (!live) return base;
  const na: string[] = ['Face Value', 'Industry P/E'];
  const pick = (label: string, l: number | undefined, keep: number | null, ok: (n: number) => boolean = (n) => n > 0): number | null => {
    if (fin(l) && ok(l)) return l;
    if (keep === null) na.push(label);
    return keep;
  };
  const any = (n: number) => Number.isFinite(n);
  const marketCapCr = pick('Market Cap', live.marketCapCr, base.marketCapCr);
  const pe = pick('P/E', live.pe, base.pe);
  const bookValue = pick('Book Value', live.bookValue, base.bookValue);
  const dividendYield = pick('Dividend Yield', live.dividendYield, base.dividendYield, (n) => n >= 0);
  const roe = pick('ROE', live.roe, base.roe, any);
  const roce = pick('ROCE', live.roce, base.roce, any);
  const eps = pick('EPS', live.eps, base.eps, any);
  let debtToEquity = base.debtToEquity;
  if (fin(live.debtToEquity)) debtToEquity = live.debtToEquity;
  else na.push('D/E');

  const liveRange = fin(live.high52) && fin(live.low52) && live.high52 > live.low52;
  const high52 = liveRange ? Math.max(live.high52!, ltp) : null;
  const low52 = liveRange ? Math.min(live.low52!, ltp) : null;
  if (!liveRange) na.push('52W range');

  const useQ = live.quarters.length >= 2;
  if (!useQ) na.push('Quarterly results');

  let holding = base.holding;
  const h = live.holding;
  if (h) {
    const promoters = rnd(Math.min(100, Math.max(0, h.promoters)), 1);
    const institutions = rnd(Math.min(100 - promoters, Math.max(0, h.institutions)), 1);
    holding = { promoters, institutions, public: Math.max(0, rnd(100 - promoters - institutions, 1)) };
  } else na.push('Shareholding');

  const anyLive = [live.marketCapCr, live.pe, live.bookValue, live.dividendYield, live.roe, live.roce, live.eps, live.debtToEquity].some(fin) || liveRange || useQ || !!h;
  return {
    ...base,
    marketCapCr, pe, bookValue, dividendYield, roe, roce, eps, debtToEquity, high52, low52,
    quarters: useQ ? live.quarters : [],
    holding,
    source: { live: anyLive, quarters: useQ, holding: !!h, na, asOf: live.fetchedAt },
  };
}
