import { isMarketOpen } from './market';
/** Provenance of history-based risk numbers: 1Y daily closes are always an end-of-day baseline; during the NSE session the live leg (prices, weights) comes from SmartAPI. */
export const BASELINE_LIVE = 'SmartAPI Live + EOD Baseline';
export const BASELINE_EOD = 'EOD Historical Baseline';
export const baselineLabel = (nowMs: number): string => (isMarketOpen(nowMs) ? BASELINE_LIVE : BASELINE_EOD);
