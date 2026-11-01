import type { FeedMode, MarketEngine } from '@/lib/market';
import type { Holding, Quote } from '@/lib/types';

export interface DashboardProps {
  engine: MarketEngine;
  quote: Quote;
  /** daily closes for the selected symbol (last bar = live LTP) */
  closes1D: number[];
  holdings: Holding[];
  favorites: string[];
  knownSymbols: ReadonlySet<string>;
  mode: FeedMode;
  onSelect: (symbol: string) => void;
  onToggleFavorite: (symbol: string) => void;
  /** opens the CSV / image / PDF import modal */
  onOpenImport: () => void;
  /** opens the ⚖️ Rebalance Portfolio simulator */
  onOpenRebalance: () => void;
  onAskAI: (prompt?: string) => void;
  /** sets a price alert (Day Trader skill 11); `ltp` decides above/below */
  onAddAlert?: (symbol: string, target: number, ltp: number) => { ok: true } | { ok: false; error: string };
  onResetPortfolio: () => void;
  /** dispatches a terminal action from the hotkey panel */
  onAction: (key: string) => void;
}
