export interface Instrument {
  symbol: string;
  name: string;
  sector: string;
  /** listing venue; absent = NSE. BSE-only names carry "BSE" (dual-listed names are kept as NSE). */
  exch?: 'NSE' | 'BSE';
}

export interface Quote extends Instrument {
  ltp: number;
  prevClose: number;
  open: number;
  high: number;
  low: number;
  volume: number;
  /** Σ(price × volume) and Σ(volume) for session VWAP */
  sumPV: number;
  sumV: number;
  /** Market cap in ₹ crore */
  mcapCr: number;
  /** Trailing dividend yield, % */
  dividendYield: number;
  /** Typical full-day volume (shares) — baseline for surge detection */
  avgVolume: number;
  /** Price band in %, and the resulting circuit prices */
  circuitBand: number;
  upperCircuit: number;
  lowerCircuit: number;
}

/** Bar intervals: 1m…1M. Ranges: 1Y (daily bars), 5Y (weekly bars), 10Y (monthly bars). */
export type Timeframe = '1m' | '5m' | '15m' | '1h' | '1D' | '1W' | '1M' | '1Y' | '5Y' | '10Y';

export interface Candle {
  time: number; // seconds, IST-shifted so the chart axis reads in IST
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface IndexQuote {
  id: string;
  label: string;
  value: number;
  prev: number;
  change: number;
  pct: number;
}

export interface DepthLevel {
  price: number;
  qty: number;
  orders: number;
}

export interface OrderBook {
  bids: DepthLevel[];
  asks: DepthLevel[];
}

export interface Holding {
  symbol: string;
  qty: number;
  avg: number;
}

export type AlertKind = 'UPPER_CIRCUIT' | 'LOWER_CIRCUIT' | 'PRICE_SURGE' | 'VOLUME_SURGE';

export interface MarketAlert {
  id: number;
  kind: AlertKind;
  symbol: string;
  time: number;
  /** ratio vs normal for surges (e.g. 4.2×), or % move for circuits */
  value: number;
  message: string;
}

export type SentimentLabel = 'Bullish' | 'Bearish' | 'Neutral';

export interface NewsItem {
  id: string;
  title: string;
  link: string;
  source: string;
  /** epoch ms (0 if unknown) */
  published: number;
  /** −1 … +1 from the local VADER + financial-rules scorer */
  score: number;
  label: SentimentLabel;
}

export interface NewsResponse {
  items: NewsItem[];
  /** 'live' = fetched from RSS, 'sample' = built-in demo headlines because every feed failed */
  mode: 'live' | 'sample';
  errors: string[];
  fetchedAt: number;
}

export interface Fundamentals {
  marketCapCr: number;
  pe: number;
  bookValue: number;
  dividendYield: number;
  roce: number;
  roe: number;
  /** null for banks / lenders, where leverage ratios aren't meaningful */
  debtToEquity: number | null;
  promoterHolding: number;
  eps: number;
}
