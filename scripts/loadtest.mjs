// Dependency-free load test: `node scripts/loadtest.mjs [baseUrl] [seconds] [concurrency]`. Hits the public read endpoints and prints throughput + latency percentiles.
const base = process.argv[2] || 'http://localhost:3000', secs = +(process.argv[3] || 10), conc = +(process.argv[4] || 20);
const targets = ['/api/health', '/api/quotes?s=RELIANCE,TCS', '/legal/privacy', '/status'];
const lat = new Map(targets.map((t) => [t, []])); const codes = {}; let stop = false;
async function worker(i) {
  let k = i;
  while (!stop) {
    const t = targets[k++ % targets.length], s = performance.now();
    try { const r = await fetch(base + t, { headers: { 'x-forwarded-for': `10.0.${i}.1` } }); await r.arrayBuffer(); lat.get(t).push(performance.now() - s); codes[r.status] = (codes[r.status] || 0) + 1; }
    catch { codes.err = (codes.err || 0) + 1; }
  }
}
const q = (a, p) => (a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))] : NaN);
setTimeout(() => (stop = true), secs * 1000);
await Promise.all(Array.from({ length: conc }, (_, i) => worker(i)));
let total = 0;
for (const [t, a] of lat) { total += a.length; console.log(t.padEnd(30), `n=${String(a.length).padEnd(6)} p50=${q(a, .5).toFixed(0)}ms p95=${q(a, .95).toFixed(0)}ms p99=${q(a, .99).toFixed(0)}ms`); }
console.log(`total ${total} req in ${secs}s = ${(total / secs).toFixed(0)} req/s · status ${JSON.stringify(codes)}`);
const bad = (codes.err || 0) + Object.entries(codes).filter(([c]) => +c >= 500 && +c !== 502).reduce((a, [, n]) => a + n, 0);
process.exit(bad ? 1 : 0);
