'use client';

import { useEffect, useState } from 'react';
import { SEED_INSTRUMENTS, loadInstrumentMaster } from '@/lib/instruments';
import type { Instrument } from '@/lib/types';

export function useInstruments(): Instrument[] {
  const [items, setItems] = useState<Instrument[]>(SEED_INSTRUMENTS);
  useEffect(() => {
    const ac = new AbortController();
    loadInstrumentMaster(ac.signal).then((rows) => {
      if (!ac.signal.aborted) setItems(rows);
    });
    return () => ac.abort();
  }, []);
  return items;
}
