// Client-only helpers for the portfolio importer: PDF text extraction, in-browser OCR (tesseract.js) and image prep.
// All assets are self-hosted under /ocr (copied from node_modules by scripts/copy-ocr-assets.mjs) — no CDN calls.

const origin = () => window.location.origin;

/** Decode an image File/Blob to a canvas, scaled so its long edge is within [minEdge, maxEdge]. */
export async function imageToCanvas(src: Blob, opts: { minEdge?: number; maxEdge?: number } = {}): Promise<HTMLCanvasElement> {
  const { minEdge = 0, maxEdge = 3000 } = opts;
  const bmp = await createImageBitmap(src);
  const long = Math.max(bmp.width, bmp.height);
  const k = long < minEdge ? Math.min(2.5, minEdge / long) : long > maxEdge ? maxEdge / long : 1;
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k);
  c.height = Math.round(bmp.height * k);
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#fff'; // transparent PNGs → white background for OCR
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  return c;
}

/** JPEG base64 (no data: prefix) of a canvas, shrunk until it fits `maxBytes` — for the optional Gemini vision upload. */
export function canvasToJpegBase64(c: HTMLCanvasElement, maxEdge = 1600, maxBytes = 1_300_000): string {
  let k = Math.min(1, maxEdge / Math.max(c.width, c.height));
  for (let i = 0; i < 4; i++) {
    const t = document.createElement('canvas');
    t.width = Math.round(c.width * k);
    t.height = Math.round(c.height * k);
    t.getContext('2d')!.drawImage(c, 0, 0, t.width, t.height);
    const b64 = t.toDataURL('image/jpeg', 0.85).split(',')[1];
    if (b64.length * 0.75 <= maxBytes) return b64;
    k *= 0.75;
  }
  throw new Error('Image is too large to upload');
}

/** Run Tesseract OCR on a canvas. Returns recognised text with line breaks preserved. */
export async function ocrCanvas(canvas: HTMLCanvasElement, onProgress?: (p: number, status: string) => void): Promise<string> {
  const { createWorker } = await import('tesseract.js');
  const worker = await createWorker('eng', 1, {
    workerPath: `${origin()}/ocr/worker.min.js`,
    corePath: `${origin()}/ocr`,
    langPath: `${origin()}/ocr`,
    gzip: true,
    logger: (m: { status: string; progress: number }) => onProgress?.(m.progress, m.status),
  });
  try {
    await worker.setParameters({ tessedit_pageseg_mode: '6' as never, preserve_interword_spaces: '1' });
    const { data } = await worker.recognize(canvas);
    return data.text;
  } finally {
    await worker.terminate();
  }
}

async function loadPdf(file: File) {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = `${origin()}/ocr/pdf.worker.min.js`;
  return pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
}

/** Text layer of a PDF, rebuilt into lines (items grouped by baseline, ordered left → right). */
export async function pdfToText(file: File, maxPages = 10): Promise<string> {
  const doc = await loadPdf(file);
  const out: string[] = [];
  for (let p = 1; p <= Math.min(doc.numPages, maxPages); p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const rows = new Map<number, { x: number; s: string }[]>();
    for (const it of content.items as { str: string; transform: number[] }[]) {
      if (!it.str.trim()) continue;
      const y = Math.round(it.transform[5] / 3); // 3pt tolerance → same visual line
      const r = rows.get(y) ?? [];
      r.push({ x: it.transform[4], s: it.str });
      rows.set(y, r);
    }
    Array.from(rows.entries())
      .sort((a, b) => b[0] - a[0]) // PDF y grows upwards
      .forEach(([, r]) => out.push(r.sort((a, b) => a.x - b.x).map((c) => c.s).join(' ')));
  }
  return out.join('\n');
}

/** Rasterise the first pages of a (scanned) PDF so they can go through OCR / vision. */
export async function pdfToCanvases(file: File, maxPages = 3, scale = 2): Promise<HTMLCanvasElement[]> {
  const doc = await loadPdf(file);
  const pages: HTMLCanvasElement[] = [];
  for (let p = 1; p <= Math.min(doc.numPages, maxPages); p++) {
    const page = await doc.getPage(p);
    const vp = page.getViewport({ scale });
    const c = document.createElement('canvas');
    c.width = Math.round(vp.width);
    c.height = Math.round(vp.height);
    await page.render({ canvasContext: c.getContext('2d')!, viewport: vp }).promise;
    pages.push(c);
  }
  return pages;
}
