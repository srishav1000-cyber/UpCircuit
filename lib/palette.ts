// Command palette model: pure filtering / ranking (the component only renders and dispatches).
export interface Command { id: string; label: string; hint?: string; group: 'Go to' | 'Stocks' | 'Workspace' | 'Layouts' | 'Account'; keywords?: string; run: () => void; keepOpen?: boolean }

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
/** 0 = no match; higher is better. Prefix of a word > substring > all query words present (any order) > subsequence of the label. */
export function score(c: Pick<Command, 'label' | 'keywords' | 'hint'>, q: string): number {
  const query = norm(q);
  if (!query) return 1;
  const label = norm(c.label), hay = norm(`${c.label} ${c.keywords ?? ''} ${c.hint ?? ''}`);
  if (label === query) return 100;
  if (label.startsWith(query)) return 90;
  if (label.split(' ').some((w) => w.startsWith(query))) return 75;
  if (label.includes(query)) return 60;
  const words = query.split(' ');
  if (words.every((w) => hay.includes(w))) return 45;
  let i = 0; for (const ch of label) if (ch === query[i]) i++;
  return i === query.length && query.length >= 2 ? 20 : 0;
}
export function rank(cmds: Command[], q: string, max = 12): Command[] {
  return cmds.map((c) => ({ c, s: score(c, q) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, max).map((x) => x.c);
}
