// Accessibility audit: axe-core (WCAG 2.1 A/AA) over key screens in headless Chromium.
// Usage: BASE=http://localhost:3000 node scripts/a11y.cjs   (needs `playwright` + `axe-core` resolvable; the app must be running)
const { chromium } = require('playwright'); const axe = require('axe-core');
const BASE = process.env.BASE || 'http://localhost:3000';
(async () => {
  const b = await chromium.launch({ args: ['--no-sandbox'], executablePath: process.env.CHROME || undefined }); const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const pages = ['/', '/login', '/status', '/privacy', '/terms', '/disclaimer', '/data-licence'];
  let bad = 0;
  for (const path of pages) {
    await p.goto(BASE + path, { waitUntil: 'networkidle' }).catch(() => {}); await p.waitForTimeout(800);
    await p.evaluate(axe.source); const r = await p.evaluate(() => window.axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] }));
    const v = r.violations.filter((x) => x.impact === 'serious' || x.impact === 'critical'); bad += v.length;
    console.log(`${path}: ${r.violations.length} violations (${v.length} serious/critical)`); for (const x of r.violations) console.log(`   [${x.impact}] ${x.id} ×${x.nodes.length} — ${x.help}  e.g. ${x.nodes[0].target.join(' ')}`);
  }
  await b.close(); process.exit(bad ? 1 : 0);
})();
