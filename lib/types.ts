export interface Instrument {
  symbol: string;
  name: string;
  sector: string;
  /** listing venue; absent = NSE. BSE-only names carry "BSE" (dual-listed names are kept as NSE). */
  exch?: 'NSE' | 'BSE';
  /** BSE scrip code (e.g. 500325 = RELIANCE) — searchable by number; present once the master was synced from Angel One's scrip master */
  code?: string;
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
  /** true when upper/lower came from the exchange (SmartAPI); false = inferred (Yahoo has no per-stock band) */
  bandKnown?: boolean;
  /** epoch ms the quote was last refreshed from Yahoo / SmartAPI */
  fetchedAt?: number;
  /** exchange time of the last trade (epoch ms), when Yahoo reports it */
  marketTime?: number;
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
  /** false until the first real value has arrived */
  loaded?: boolean;
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
  /** stock symbols mentioned in the headline (ticker or company name) */
  symbols?: string[];
}

export interface NewsResponse {
  items: NewsItem[];
  /** 'live' = fetched from RSS, 'sample' = built-in demo headlines because every feed failed */
  mode: 'live' | 'sample';
  errors: string[];
  fetchedAt: number;
  /** off-topic headlines dropped by the market-relevance filter */
  filtered?: number;
}

export interface Fundamentals {
  /** every field is null when no real value is available (rendered "N/A") */
  marketCapCr: number | null;
  pe: number | null;
  bookValue: number | null;
  dividendYield: number | null;
  roce: number | null;
  roe: number | null;
  /** null for banks / lenders (leverage ratios aren't meaningful) and when unknown */
  debtToEquity: number | null;
  promoterHolding: number | null;
  eps: number | null;
}
