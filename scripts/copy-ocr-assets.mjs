// Copies self-hosted OCR / PDF assets into public/ocr so the portfolio importer works with no CDN calls.
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const nm = join(process.cwd(), 'node_modules');
const out = join(process.cwd(), 'public', 'ocr');
const files = [
  ['tesseract.js/dist/worker.min.js', 'worker.min.js'],
  ['tesseract.js-core/tesseract-core-lstm.wasm.js', 'tesseract-core-lstm.wasm.js'],
  ['tesseract.js-core/tesseract-core-simd-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js'],
  ['@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz', 'eng.traineddata.gz'],
  ['pdfjs-dist/build/pdf.worker.min.js', 'pdf.worker.min.js'],
];
mkdirSync(out, { recursive: true });
let n = 0;
for (const [src, dst] of files) {
  const from = join(nm, src);
  if (existsSync(from)) (cpSync(from, join(out, dst)), n++);
  else console.warn('[ocr-assets] missing', src, '(image/PDF import will be unavailable)');
}
console.log(`[ocr-assets] copied ${n}/${files.length} files to public/ocr`);
