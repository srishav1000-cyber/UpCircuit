'use client';
// Back-compat shim: favourites are the watchlist (see useWatchlist).
import { useWatchlist } from './useWatchlist';

export function useFavorites() {
  const { list, toggle } = useWatchlist();
  return { favs: list, toggle };
}
