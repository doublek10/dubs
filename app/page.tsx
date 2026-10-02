'use client';
import { penErase, eraseRect, penBoxesFrom, LUM } from './lib/ink';
import { useRef, useState, useEffect, useCallback } from 'react';

type Item = { col?: string; ff?: string; id: string; t: 'text' | 'date' | 'check' | 'image'; x: number; y: number; w: number; ar: number; text?: string; fs?: number; src?: string; on?: boolean };
type Edit = { er: number[][]; hl?: number[][]; pen?: number[][]; keep?: number[][]; items: Item[] }; // er: [x,y,w,h] as page fractions
type Pg = { src: string; w: number; h: number; fields?: number[][] };
const MAX_BYTES = 25 * 1024 * 1024, MAX_PAGES = 30;
const uid = () => crypto.randomUUID();
const loadImg = (s: string) => new Promise<HTMLImageElement>((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = s; });
const today = () => new Date().toLocaleDateString('en-GB');

type Tok = { base: string; token: string; exp: number };
let TK: Tok | null = null, SID = ''; // SID: current processor session (temporary, deleted on finish)
let PHOTO: { quad: number[] | null; url: string } | null = null;
let WORDS: { r: number[]; t: string }[][] = []; // OCR words per page (for tap-to-edit)
const FF: Record<string, string> = { sans: 'Arial, Helvetica, sans-serif', serif: 'Georgia, "Times New Roman", serif', mono: '"Courier New", monospace' };
const IDW = /\d{5,}/;
async function tok(): Promise<Tok> {
  if (TK && TK.exp * 1000 > Date.now() + 30000) return TK;
  const r = await fetch('/api/token', { method: 'POST', headers: { 'x-access-code': sessionStorage.getItem('ddcode') || '' } });
  if (r.status === 401) { const c = window.prompt('Access code'); if (!c) throw new Error('Access code required.'); sessionStorage.setItem('ddcode', c); return tok(); }
  if (!r.ok) throw new Error('Processor unavailable'); TK = await r.json(); return TK!;
}
async function api(path: string, init: RequestInit = {}) { const t = await tok(); return fetch(t.base + path, { ...init, headers: { ...(init.headers || {}), 'X-DD-Token': t.token } }); }
const toUrl = (b: Blob) => new Promise<string>(res => { const f = new FileReader(); f.onload = () => res(f.result as string); f.readAsDataURL(b); });
const ekey = (e?: Edit) => JSON.stringify([(e?.er || []).map(r => r.slice(0, 4)), e?.pen || [], e?.keep || []]);
const EMPTY = '[[],[],[]]';
async function remoteIngest(file: File): Promise<Pg[]> { // DOC/DOCX/PDF/photos are converted, rendered and corrected on the processor
  const fd = new FormData(); fd.append('file', file);
  const r = await api('/sessions', { method: 'POST', body: fd }); const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'processor error');
  SID = j.id; PHOTO = j.photo ? { quad: j.quad, url: URL.createObjectURL(file) } : null; const out: Pg[] = [];
  for (let n = 1; n <= j.pages.length; n++) out.push({ src: await toUrl(await (await api(`/sessions/${SID}/pages/${n}`)).blob()), w: j.pages[n - 1].w, h: j.pages[n - 1].h });
  return out;
}
async function serverAnalyze(pages: Pg[]): Promise<Edit[] | null> { // OCR on the processor; low-confidence finds are highlighted, not erased
  if (!SID) return null;
  const r = await api(`/sessions/${SID}/analyze`, { method: 'POST' }); if (!r.ok) return null; const j = await r.json(); if (!j.ocr) return null; WORDS = j.words || [];
  const out: Edit[] = [];
  for (let p = 0; p < pages.length; p++) { const e: Edit = { er: [], hl: [], items: [] };
    for (const q of j.pages[p] || []) { if (q.unc) { e.hl!.push(q.r); continue; } e.er.push([...q.r, await bgOf(pages[p], q.r)]);
      if (q.id) e.items.push({ id: uid(), t: 'text', x: q.r[0] + 2 / pages[p].w, y: q.r[1] + 2 / pages[p].h, w: q.r[2], ar: 0.05, text: q.text, fs: q.h * 0.9 }); }
    out.push(e); }
  return out;
}

async function ingest(file: File): Promise<Pg[]> {
  if (file.size > MAX_BYTES) throw new Error('This document is too large to process.\n\nPlease use a smaller document.');
  const fd = new FormData();
  fd.append('head', file.slice(0, 16384));
  if (/\.docx?$/i.test(file.name)) fd.append('file', file);
  const r = await fetch('/api/ingest', { method: 'POST', body: fd });
  let blob: Blob = file, kind = '';
  if ((r.headers.get('content-type') || '').includes('application/pdf')) { blob = await r.blob(); kind = 'pdf'; }
  else { const j = await r.json(); if (!j.ok) throw new Error(j.error); kind = j.kind; }
  if (kind === 'pdf') {
    const pdfjs = await import('pdfjs-dist');
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();
    const doc = await pdfjs.getDocument({ data: await blob.arrayBuffer() }).promise;
    if (doc.numPages > MAX_PAGES) throw new Error(`This document has more than ${MAX_PAGES} pages.`);
    const out: Pg[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const p = await doc.getPage(n), v0 = p.getViewport({ scale: 1 }), v = p.getViewport({ scale: Math.min(3, 1600 / v0.width) });
      const c = document.createElement('canvas'); c.width = v.width; c.height = v.height;
      await p.render({ canvasContext: c.getContext('2d')!, viewport: v }).promise;
      const fl: number[][] = []; // filled form fields -> removable areas
      for (const a of await p.getAnnotations()) if (a.subtype === 'Widget' && a.fieldValue && a.fieldValue !== 'Off') { const [x1, y1, x2, y2] = v.convertToViewportRectangle(a.rect); fl.push([Math.min(x1, x2) / c.width, Math.min(y1, y2) / c.height, Math.abs(x2 - x1) / c.width, Math.abs(y2 - y1) / c.height]); }
      out.push({ src: c.toDataURL('image/jpeg', 0.92), w: c.width, h: c.height, fields: fl });
    }
    return out;
  }
  if (kind === 'heic') blob = (await (await import('heic2any')).default({ blob: file, toType: 'image/jpeg' })) as Blob;
  const u = URL.createObjectURL(blob), im = await loadImg(u);
  const s = Math.min(1, 2000 / Math.max(im.width, im.height)), c = document.createElement('canvas');
  c.width = Math.round(im.width * s); c.height = Math.round(im.height * s);
  c.getContext('2d')!.drawImage(im, 0, 0, c.width, c.height); URL.revokeObjectURL(u);
  return [{ src: c.toDataURL('image/jpeg', 0.92), w: c.width, h: c.height }];
}

const col = (n?: number) => '#' + (n ?? 0xffffff).toString(16).padStart(6, '0');
const ctxCache = new Map<string, CanvasRenderingContext2D>();
async function bgOf(pg: Pg, r: number[]): Promise<number> { // sample paper colour just outside the erased box
  let g = ctxCache.get(pg.src);
  if (!g) { const im = await loadImg(pg.src), c = document.createElement('canvas'); c.width = pg.w; c.height = pg.h; g = c.getContext('2d', { willReadFrequently: true })!; g.drawImage(im, 0, 0, pg.w, pg.h); ctxCache.set(pg.src, g); }
  const ch: number[][] = [[], [], []], cl = (v: number, m: number) => Math.min(m - 1, Math.max(0, Math.round(v)));
  for (let k = 0; k <= 6; k++) for (const y of [r[1] * pg.h - 3, (r[1] + r[3]) * pg.h + 3]) { const d = g.getImageData(cl((r[0] + r[2] * k / 6) * pg.w, pg.w), cl(y, pg.h), 1, 1).data; ch[0].push(d[0]); ch[1].push(d[1]); ch[2].push(d[2]); }
  const m = (a: number[]) => a.sort((p, q) => p - q)[a.length >> 1];
  return (m(ch[0]) << 16) | (m(ch[1]) << 8) | m(ch[2]);
}
const IDL = /(document|reference|ref|tracking|serial|invoice|receipt|application|certificate|file|registration|order)\s*(no|number|num|#)/i;
async function autoClean(pages: Pg[]): Promise<Edit[]> { // OCR runs in a browser worker; text never leaves the device
  const { createWorker } = await import('tesseract.js');
  const w = await createWorker('eng', 1, { workerPath: '/tesseract/worker.min.js', corePath: '/tesseract', langPath: '/tesseract' });
  const out: Edit[] = [];
  try {
    for (const pg of pages) {
      const e: Edit = { er: [], items: [] }, pend: { r: number[]; text: string; id: boolean; h: number }[] = [];
      for (const f of pg.fields || []) e.er.push([...f, await bgOf(pg, f)]);
      const { data } = await w.recognize(pg.src);
      WORDS[out.length] = data.words.map((x: any) => ({ r: [x.bbox.x0 / pg.w, x.bbox.y0 / pg.h, (x.bbox.x1 - x.bbox.x0) / pg.w, (x.bbox.y1 - x.bbox.y0) / pg.h], t: x.text }));
      for (const ln of data.lines) {
        const ws = ln.words.filter((x: any) => x.text.trim()); let lab = '', vals: any[] = [];
        const flush = () => { const vs = vals.filter(v => !/^[_.\-–—|]+$/.test(v.text)); vals = []; if (!vs.length) return;
          const x0 = Math.min(...vs.map(v => v.bbox.x0)), x1 = Math.max(...vs.map(v => v.bbox.x1)), y0 = Math.min(...vs.map(v => v.bbox.y0)), y1 = Math.max(...vs.map(v => v.bbox.y1));
          pend.push({ r: [(x0 - 2) / pg.w, (y0 - 2) / pg.h, (x1 - x0 + 4) / pg.w, (y1 - y0 + 4) / pg.h], text: vs.map(v => v.text).join(' '), id: IDL.test(lab), h: (y1 - y0) / pg.w }); };
        ws.forEach((wd: any, i: number) => { if (wd.text.endsWith(':')) { flush(); lab = ws.slice(Math.max(0, i - 3), i + 1).map((x: any) => x.text).join(' '); } else if (lab) vals.push(wd); });
        flush();
      }
      for (const q of pend) { e.er.push([...q.r, await bgOf(pg, q.r)]); // identifiers become editable text with matching size
        if (q.id) e.items.push({ id: uid(), t: 'text', x: q.r[0] + 2 / pg.w, y: q.r[1] + 2 / pg.h, w: q.r[2], ar: 0.05, text: q.text, fs: q.h * 0.9 }); }
      out.push(e);
    }
  } finally { await w.terminate(); }
  return out;
}

async function pixels(pg: Pg) { const im = await loadImg(pg.src), c = document.createElement('canvas'); c.width = pg.w; c.height = pg.h; const g = c.getContext('2d', { willReadFrequently: true })!; g.drawImage(im, 0, 0, pg.w, pg.h); return { c, g, id: g.getImageData(0, 0, pg.w, pg.h) }; }
async function penBoxes(pg: Pg) { const { id } = await pixels(pg); return penBoxesFrom(id.data, pg.w, pg.h); }
async function renderEdits(pg: Pg, e: Edit): Promise<string> { // pen removal + manual erase, in the browser (fast; works with or without the processor)
  const { c, g, id } = await pixels(pg); const orig = (e.keep || []).length ? new Uint8ClampedArray(id.data) : null; (e.pen || []).forEach(r => penErase(id.data, pg.w, pg.h, r)); e.er.forEach(r => eraseRect(id.data, pg.w, pg.h, r));
  (e.keep || []).forEach(r => { const x0 = Math.max(0, Math.floor(r[0] * pg.w)), x1 = Math.min(pg.w, Math.ceil((r[0] + r[2]) * pg.w)), y0 = Math.max(0, Math.floor(r[1] * pg.h)), y1 = Math.min(pg.h, Math.ceil((r[1] + r[3]) * pg.h)); // Restore brush: bring the original back
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const o = (y * pg.w + x) * 4; for (let k = 0; k < 3; k++) id.data[o + k] = orig![o + k]; } });
  g.putImageData(id, 0, 0); return c.toDataURL('image/jpeg', 0.92);
}
async function inkOf(pg: Pg, r: number[]): Promise<string> { // darkest colour in a word box = its ink colour
  const { id } = await pixels(pg), x0 = Math.floor(r[0] * pg.w), y0 = Math.floor(r[1] * pg.h), x1 = Math.ceil((r[0] + r[2]) * pg.w), y1 = Math.ceil((r[1] + r[3]) * pg.h); let best = 999, col = '#000000';
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const o = (y * pg.w + x) * 4, l = LUM(id.data[o], id.data[o + 1], id.data[o + 2]); if (l < best) { best = l; col = '#' + [0, 1, 2].map(k => id.data[o + k].toString(16).padStart(2, '0')).join(''); } }
  return col;
}
async function flatten(pg: Pg, e: Edit, skip = false): Promise<string> {
  const c = document.createElement('canvas'); c.width = pg.w; c.height = pg.h;
  const g = c.getContext('2d')!, W = pg.w, H = pg.h;
  g.drawImage(await loadImg(pg.src), 0, 0, W, H);
  if (!skip) e.er.forEach(([x, y, w, h, k]) => { g.fillStyle = col(k); g.fillRect(x * W, y * H, w * W, h * H); });
  for (const i of e.items) {
    const x = i.x * W, y = i.y * H, w = i.w * W, h = w * i.ar;
    if (i.t === 'image' && i.src) g.drawImage(await loadImg(i.src), x, y, w, h);
    else if (i.t === 'check') {
      g.strokeStyle = '#000'; g.lineWidth = w * 0.08; g.strokeRect(x, y, w, h);
      if (i.on) { g.beginPath(); g.moveTo(x + w * .2, y + h * .55); g.lineTo(x + w * .42, y + h * .78); g.lineTo(x + w * .82, y + h * .22); g.stroke(); }
    } else { g.fillStyle = i.col || '#000'; g.textBaseline = 'top'; const fs = (i.fs || 0.02) * W; g.font = `${fs}px ${FF[i.ff || 'sans']}`; (i.text || '').split('\n').forEach((l, k) => g.fillText(l, x, y + k * fs * 1.1)); }
  }
  return c.toDataURL('image/jpeg', 0.92);
}

export default function Home() {
  const [stage, setStage] = useState<'up' | 'busy' | 'ready' | 'edit' | 'prev' | 'done'>('up'); const [msg, setMsg] = useState('Working…'); const [bgs, setBgs] = useState<Record<number, { k: string; src: string }>>({}); const [crop, setCrop] = useState(false); const [, setWv] = useState(0);
  const [pages, setPages] = useState<Pg[]>([]);
  const [hist, setHist] = useState<{ past: Edit[][]; cur: Edit[]; future: Edit[][] }>({ past: [], cur: [], future: [] });
  const [tool, setTool] = useState<'move' | 'erase' | 'restore' | 'text'>('move');
  const [sel, setSel] = useState<{ p: number; id: string } | null>(null);
  const [zoom, setZoom] = useState(1), [err, setErr] = useState(''), [over, setOver] = useState(false);
  const [draft, setDraft] = useState<{ p: number; r: number[] } | null>(null);
  const [sig, setSig] = useState(false), [previews, setPreviews] = useState<string[]>([]);
  const refs = useRef<(HTMLDivElement | null)[]>([]);
  const fileIn = useRef<HTMLInputElement>(null), imgIn = useRef<HTMLInputElement>(null);
  const cur = hist.cur; const okp = (p: number) => !!bgs[p] && bgs[p].k === ekey(cur[p]);

  const commit = (fn: (e: Edit[]) => Edit[]) => setHist(h => ({ past: [...h.past, h.cur], cur: fn(h.cur), future: [] }));
  const live = (fn: (e: Edit[]) => Edit[]) => setHist(h => ({ ...h, cur: fn(h.cur) }));
  const undo = () => setHist(h => h.past.length ? { past: h.past.slice(0, -1), cur: h.past.at(-1)!, future: [h.cur, ...h.future] } : h);
  const redo = () => setHist(h => h.future.length ? { past: [...h.past, h.cur], cur: h.future[0], future: h.future.slice(1) } : h);
  const patch = (p: number, id: string, d: Partial<Item>, rec = true) => (rec ? commit : live)(e => e.map((x, k) => k !== p ? x : { ...x, items: x.items.map(i => i.id === id ? { ...i, ...d } : i) }));
  const add = (p: number, i: Omit<Item, 'id' | 'x' | 'y'>) => { const id = uid(); commit(e => e.map((x, k) => k !== p ? x : { ...x, items: [...x.items, { ...i, id, x: 0.3, y: 0.3 }] })); setSel({ p, id }); setTool('move'); };
  const visiblePage = () => { const v = document.querySelector('.view') as HTMLElement | null; if (!v) return 0; const mid = v.getBoundingClientRect().top + v.clientHeight / 2; const k = refs.current.findIndex(r => r && r.getBoundingClientRect().bottom > mid); return Math.max(0, k); };

  const open = async (f?: File) => {
    if (!f) return; setErr(''); setMsg('Working…'); setStage('busy');
    try { const pg = await remoteIngest(f).catch(() => { SID = ''; return ingest(f); }); setPages(pg); setHist({ past: [], cur: pg.map(() => ({ er: [], items: [] })), future: [] }); setStage('ready'); }
    catch (x: any) { setErr(x?.name === 'PasswordException' ? 'This PDF is password-protected.\n\nRemove the password and try again.' : x?.message || 'We couldn’t read this document.\n\nIt may be corrupted, password-protected, or in an unsupported format.'); setStage('up'); }
  };
  const reset = () => { if (SID) { api(`/sessions/${SID}`, { method: 'DELETE', keepalive: true }).catch(() => {}); SID = ''; } if (PHOTO) { URL.revokeObjectURL(PHOTO.url); PHOTO = null; } WORDS = []; setBgs({}); ctxCache.clear(); setPages([]); setHist({ past: [], cur: [], future: [] }); setPreviews([]); setSel(null); setErr(''); setStage('up'); };

  const drag = (ev: React.PointerEvent, p: number, i: Item, mode: 'mv' | 'rs') => {
    ev.stopPropagation(); setSel({ p, id: i.id });
    const r = refs.current[p]!.getBoundingClientRect(), sx = ev.clientX, sy = ev.clientY, snap = hist.cur;
    const mv = (e: PointerEvent) => { const dx = (e.clientX - sx) / r.width, dy = (e.clientY - sy) / r.height;
      patch(p, i.id, mode === 'mv' ? { x: Math.min(1, Math.max(0, i.x + dx)), y: Math.min(1, Math.max(0, i.y + dy)) } : { w: Math.max(0.02, i.w + dx) }, false); };
    const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); setHist(h => ({ ...h, past: [...h.past, snap], future: [] })); };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
  };
  const pageDown = (ev: React.PointerEvent, p: number) => {
    if (tool === 'text') { const r = refs.current[p]!.getBoundingClientRect(), fx = (ev.clientX - r.left) / r.width, fy = (ev.clientY - r.top) / r.height, m = 0.008;
      const w = (WORDS[p] || []).find(w => fx >= w.r[0] - m && fx <= w.r[0] + w.r[2] + m && fy >= w.r[1] - m && fy <= w.r[1] + w.r[3] + m); if (w) editWord(p, w); return; }
    if (tool !== 'erase' && tool !== 'restore') { setSel(null); return; }
    const r = refs.current[p]!.getBoundingClientRect(), fx = (e: { clientX: number; clientY: number }) => [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height], [x0, y0] = fx(ev);
    const rect = (e: PointerEvent) => { const [x, y] = fx(e); return [Math.min(x0, x), Math.min(y0, y), Math.abs(x - x0), Math.abs(y - y0)]; };
    const mv = (e: PointerEvent) => setDraft({ p, r: rect(e) });
    const up = (e: PointerEvent) => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); const q = rect(e); setDraft(null);
      if (q[2] > 0.004 && q[3] > 0.004 && tool === 'restore') commit(es => es.map((x, k) => k === p ? { ...x, keep: [...(x.keep || []), q] } : x));
      else if (q[2] > 0.004 && q[3] > 0.004) bgOf(pages[p], q).then(c => commit(es => es.map((x, k) => k === p ? { ...x, er: [...x.er, [...q, c]] } : x))); };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
  };

  const editWord = async (p: number, w: { r: number[]; t: string }) => { // tap printed text (e.g. a serial number) -> erase it and place editable text in the same size/colour
    const pg = pages[p], c = await bgOf(pg, w.r), col = await inkOf(pg, w.r), id = uid();
    commit(es => es.map((x, k) => k !== p ? x : { ...x, er: [...x.er, [...w.r, c]], items: [...x.items, { id, t: 'text', x: w.r[0], y: w.r[1], w: w.r[2], ar: 0.05, text: w.t, fs: w.r[3] * pg.h / pg.w * 0.85, col, ff: 'sans' }] }));
    setSel({ p, id }); setTool('move'); };
  useEffect(() => { // render pen-removal + erase edits locally
    if (stage !== 'edit') return;
    const t = setTimeout(() => cur.forEach(async (e, p) => { const k = ekey(e);
      if (k === EMPTY) { if (bgs[p]) setBgs(b => { const n = { ...b }; delete n[p]; return n; }); return; }
      if (bgs[p]?.k === k) return;
      const src = await renderEdits(pages[p], e); setBgs(b => ({ ...b, [p]: { k, src } })); }), 250);
    return () => clearTimeout(t);
  }, [hist.cur, stage]);
  const download = async () => {
    if (!SID) return downloadLocal(); setStage('busy'); setMsg('Building PDF…');
    try { const fd = new FormData(); for (let k = 0; k < previews.length; k++) fd.append('pages[]', await (await fetch(previews[k])).blob(), `p${k}.jpg`);
      const r = await api(`/sessions/${SID}/output`, { method: 'POST', body: fd }); if (!r.ok) throw new Error();
      const a = document.createElement('a'); a.href = URL.createObjectURL(await r.blob()); a.download = 'document-duplicate.pdf'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      reset(); setStage('done');
    } catch { await downloadLocal(); } };
  const applyCrop = async (q: number[]) => { setCrop(false); setMsg('Straightening…'); setStage('busy');
    try { const r = await api(`/sessions/${SID}/warp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ quad: q }) }); if (!r.ok) throw new Error(); const j = await r.json();
      const src = await toUrl(await (await api(`/sessions/${SID}/pages/1`)).blob()); ctxCache.clear(); setBgs({});
      setPages([{ src, w: j.pages[0].w, h: j.pages[0].h }]); setHist({ past: [], cur: [{ er: [], items: [] }], future: [] }); setErr('');
    } catch { setErr('Crop adjustment needs the image engine (OpenCV) on the processor.'); }
    setStage('ready'); };
  const rotate = async (deg: number) => { const p = visiblePage();
    const r = await api(`/sessions/${SID}/rotate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ page: p + 1, deg }) }).catch(() => null);
    if (!r?.ok) { window.alert('Rotation isn’t available on the processor.'); return; } const j = await r.json();
    const src = await toUrl(await (await api(`/sessions/${SID}/pages/${p + 1}`)).blob());
    setPages(ps => ps.map((x, i) => i === p ? { src, w: j.page.w, h: j.page.h } : x)); setBgs(b => { const n = { ...b }; delete n[p]; return n; });
    live(es => es.map((x, i) => i === p ? { er: [], items: [] } : x)); };
  const clean = async () => { setErr(''); setMsg('Finding filled-in content…'); setStage('busy');
    try { let r: Edit[]; try { r = (await serverAnalyze(pages)) ?? (await autoClean(pages)); } catch { r = pages.map(() => ({ er: [], items: [] })); }
      for (let p = 0; p < pages.length; p++) r[p].pen = await penBoxes(pages[p]); setWv(v => v + 1); setHist({ past: [pages.map(() => ({ er: [], items: [] }))], cur: r, future: [] }); setStage('edit'); }
    catch { setErr('Automatic cleaning failed. You can still erase content by hand.'); setStage('ready'); } };
  useEffect(() => { // abandoned sessions are wiped after 30 idle minutes
    if (stage === 'up' || stage === 'done') return; const L = 30 * 60 * 1000; let t = setTimeout(reset, L);
    const b = () => { clearTimeout(t); t = setTimeout(reset, L); }; window.addEventListener('pointerdown', b); window.addEventListener('keydown', b);
    return () => { clearTimeout(t); window.removeEventListener('pointerdown', b); window.removeEventListener('keydown', b); };
  }, [stage]);
  const preview = async () => { setStage('busy'); try { setPreviews(await Promise.all(pages.map(async (p, k) => ekey(cur[k]) === EMPTY ? flatten(p, cur[k]) : flatten({ ...p, src: okp(k) ? bgs[k].src : await renderEdits(p, cur[k]) }, cur[k], true)))); setStage('prev'); } catch { setErr('Preview failed. Try again.'); setStage('edit'); } };
  const downloadLocal = async () => {
    setStage('busy');
    try {
      const { PDFDocument } = await import('pdf-lib'), pdf = await PDFDocument.create();
      for (const u of previews) { const im = await pdf.embedJpg(await (await fetch(u)).arrayBuffer()), w = 595, h = w * im.height / im.width; pdf.addPage([w, h]).drawImage(im, { x: 0, y: 0, width: w, height: h }); }
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([(await pdf.save()) as BlobPart], { type: 'application/pdf' })); a.download = 'document-duplicate.pdf'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      reset(); setStage('done');
    } catch { setErr('We couldn’t generate the PDF. Please try again.'); setStage('prev'); }
  };

  useEffect(() => { // session ends if the tab closes; nothing is persisted anywhere
    const k = (e: KeyboardEvent) => { if (stage !== 'edit') return; const m = e.ctrlKey || e.metaKey;
      if (m && e.key === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
      if ((e.key === 'Delete' || e.key === 'Backspace') && sel && !(e.target instanceof HTMLInputElement)) { commit(es => es.map((x, i) => i === sel.p ? { ...x, items: x.items.filter(t => t.id !== sel.id) } : x)); setSel(null); } };
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  });

  const si = sel ? cur[sel.p]?.items.find(i => i.id === sel.id) : undefined;
  return (
    <div className="app">
      <header><h1>Document Duplicator</h1>
        {stage === 'edit' && <><button className="btn" onClick={undo} disabled={!hist.past.length} aria-label="Undo">Undo</button><button className="btn" onClick={redo} disabled={!hist.future.length} aria-label="Redo">Redo</button><button className="btn pri" onClick={preview}>Preview</button></>}
        {stage === 'prev' && <><button className="btn" onClick={() => setStage('edit')}>Back</button><button className="btn pri" onClick={download}>Download PDF</button></>}
      </header>

      {(stage === 'up' || stage === 'busy') && <main className="center">
        <h2>Document Duplicator</h2>
        <p>Create a clean, editable duplicate of your document without permanently saving the original.</p>
        <label className={'drop' + (over ? ' over' : '')} onDragOver={e => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={e => { e.preventDefault(); setOver(false); open(e.dataTransfer.files[0]); }}>
          <strong>{stage === 'busy' ? msg : 'Upload your document'}</strong><br /><span style={{ color: 'var(--mut)' }}>PDF, DOC, DOCX, JPG, PNG, WEBP</span>
          <input ref={fileIn} type="file" hidden disabled={stage === 'busy'} accept=".pdf,.doc,.docx,.jpg,.jpeg,.png,.webp,.heic,image/*" onChange={e => { open(e.target.files?.[0]); e.target.value = ''; }} />
        </label>
        {err && <p className="err" role="alert" style={{ whiteSpace: 'pre-line' }}>{err}</p>}
      </main>}

      {stage === 'ready' && <main className="center"><h2>Duplicate created</h2><p>{pages.length} page{pages.length > 1 ? 's' : ''} ready. Your original stays unchanged.</p>
        <div style={{ display: 'grid', gap: 12, marginTop: 20 }}><button className="btn pri" onClick={() => { setErr(''); setStage('edit'); }}>Edit Document</button><button className="btn" onClick={clean}>Clean Document</button>{PHOTO && <button className="btn" onClick={() => setCrop(true)}>Adjust crop</button>}</div>
        {err && <p className="err" role="alert">{err}</p>}</main>}

      {stage === 'done' && <main className="center"><h2>Your document has been processed.</h2><p>Temporary document data has been deleted.</p><button className="btn pri" onClick={reset}>Start New Document</button></main>}

      {stage === 'prev' && <div className="view">{err && <p className="err" role="alert">{err}</p>}{previews.map((u, k) => <img key={k} className="pvimg" src={u} alt={`Page ${k + 1} preview`} />)}</div>}

      {stage === 'edit' && <div className="editor">
        <div className="tools" role="toolbar" aria-label="Tools">
          <button className="btn" onClick={() => add(visiblePage(), { t: 'text', w: 0.2, ar: 0.05, text: 'Text', fs: 0.02 })}>Text</button>
          <button className="btn" onClick={() => add(visiblePage(), { t: 'date', w: 0.2, ar: 0.05, text: today(), fs: 0.02 })}>Date</button>
          <button className="btn" onClick={() => add(visiblePage(), { t: 'check', w: 0.03, ar: 1, on: true })}>Checkbox</button>
          <button className="btn" onClick={() => setSig(true)}>Sign</button>
          <button className="btn" onClick={() => imgIn.current?.click()}>Image</button>
          {SID && <><button className="btn" aria-label="Rotate page left" onClick={() => rotate(-90)}>⟲</button><button className="btn" aria-label="Rotate page right" onClick={() => rotate(90)}>⟳</button></>}
          {PHOTO && <button className="btn" onClick={() => setCrop(true)}>Crop</button>}
          <button className={'btn' + (tool === 'text' ? ' on' : '')} aria-pressed={tool === 'text'} onClick={() => setTool(tool === 'text' ? 'move' : 'text')}>Edit text</button>
          <button className={'btn' + (tool === 'erase' ? ' on' : '')} aria-pressed={tool === 'erase'} onClick={() => setTool(tool === 'erase' ? 'move' : 'erase')}>Erase</button>
          <button className={'btn' + (tool === 'restore' ? ' on' : '')} aria-pressed={tool === 'restore'} onClick={() => setTool(tool === 'restore' ? 'move' : 'restore')}>Restore</button>
          <button className="btn" onClick={() => setZoom(z => Math.min(3, z + 0.25))} aria-label="Zoom in">+</button>
          <button className="btn" onClick={() => setZoom(z => Math.max(0.5, z - 0.25))} aria-label="Zoom out">−</button>
          <input ref={imgIn} type="file" hidden accept="image/png,image/jpeg,image/webp" onChange={async e => { const f = e.target.files?.[0]; e.target.value = ''; if (!f) return; const s = URL.createObjectURL(f), im = await loadImg(s); const c = document.createElement('canvas'), k = Math.min(1, 1000 / im.width); c.width = im.width * k; c.height = im.height * k; c.getContext('2d')!.drawImage(im, 0, 0, c.width, c.height); URL.revokeObjectURL(s); add(visiblePage(), { t: 'image', w: 0.25, ar: c.height / c.width, src: c.toDataURL('image/png') }); }} />
        </div>
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          {tool !== 'move' && <div className="sel"><span>{tool === 'erase' ? 'Drag over anything you want to REMOVE.' : tool === 'text' ? 'Tap any printed word or number to edit it.' : 'Drag over any area to bring the original back (KEEP).'}</span></div>}
          {si && tool === 'move' && <div className="sel">
            {(si.t === 'text' || si.t === 'date') && <><input aria-label="Text" value={si.text} onChange={e => patch(sel!.p, si.id, { text: e.target.value }, false)} onBlur={() => setHist(h => ({ ...h, past: [...h.past, h.cur] }))} />
              <button className="btn" onClick={() => patch(sel!.p, si.id, { fs: Math.max(0.008, (si.fs || .02) - 0.002) })}>A−</button><button className="btn" onClick={() => patch(sel!.p, si.id, { fs: (si.fs || .02) + 0.002 })}>A+</button><button className="btn" onClick={() => patch(sel!.p, si.id, { ff: si.ff === 'serif' ? 'mono' : si.ff === 'mono' ? 'sans' : 'serif' })}>{si.ff === 'serif' ? 'Serif' : si.ff === 'mono' ? 'Mono' : 'Sans'}</button></>}
            {si.t === 'check' && <button className="btn" onClick={() => patch(sel!.p, si.id, { on: !si.on })}>{si.on ? 'Uncheck' : 'Check'}</button>}
            <button className="btn" onClick={() => { commit(es => es.map((x, i) => i === sel!.p ? { ...x, items: x.items.filter(t => t.id !== si.id) } : x)); setSel(null); }}>Delete</button>
          </div>}
          <div className="view">
            {pages.map((pg, p) => <div className="pw" key={p} style={{ width: `min(${zoom * 100}%, ${zoom * 900}px)` }}>
              <div className="page" ref={el => { refs.current[p] = el; }} onPointerDown={e => pageDown(e, p)} style={{ touchAction: tool === 'erase' ? 'none' : 'auto', cursor: tool === 'erase' ? 'crosshair' : 'default' }}>
                <img className="bg" src={okp(p) ? bgs[p].src : pg.src} alt={`Page ${p + 1}`} draggable={false} />
                {cur[p]?.er.map((r, k) => <div key={k} className={'er' + (tool === 'restore' ? ' pv' : '')} style={{ left: `${r[0] * 100}%`, top: `${r[1] * 100}%`, width: `${r[2] * 100}%`, height: `${r[3] * 100}%`, background: okp(p) ? 'transparent' : col(r[4]), cursor: tool === 'restore' ? 'pointer' : 'inherit' }}
                  onPointerDown={e => { if (tool === 'restore') { e.stopPropagation(); commit(es => es.map((x, i) => i === p ? { ...x, er: x.er.filter((_, j) => j !== k) } : x)); } }} />)}
                {cur[p]?.pen?.map((r, k) => <div key={'p' + k} className={'pn' + (tool === 'restore' ? ' pv' : '')} style={{ left: `${r[0] * 100}%`, top: `${r[1] * 100}%`, width: `${r[2] * 100}%`, height: `${r[3] * 100}%` }}
                  onPointerDown={e => { if (tool === 'restore') { e.stopPropagation(); commit(es => es.map((x, i) => i === p ? { ...x, pen: (x.pen || []).filter((_, j) => j !== k) } : x)); } }} />)}
                {(tool === 'text' ? WORDS[p] || [] : (WORDS[p] || []).filter(w => IDW.test(w.t))).map((w, k) => <div key={'w' + k} className="wd" style={{ left: `${w.r[0] * 100}%`, top: `${w.r[1] * 100}%`, width: `${w.r[2] * 100}%`, height: `${w.r[3] * 100}%` }} />)}
                {cur[p]?.hl?.map((r, k) => <div key={'h' + k} className="hl" style={{ left: `${r[0] * 100}%`, top: `${r[1] * 100}%`, width: `${r[2] * 100}%`, height: `${r[3] * 100}%` }} />)}
                {draft?.p === p && <div className="er pv" style={{ left: `${draft.r[0] * 100}%`, top: `${draft.r[1] * 100}%`, width: `${draft.r[2] * 100}%`, height: `${draft.r[3] * 100}%` }} />}
                {cur[p]?.items.map(i => <div key={i.id} tabIndex={0} className={'it' + (sel?.id === i.id ? ' s' : '')} role="button" aria-label={`${i.t} item`}
                  style={{ left: `${i.x * 100}%`, top: `${i.y * 100}%`, ...(i.t === 'text' || i.t === 'date' ? { fontSize: `${(i.fs || .02) * 100}cqw`, minWidth: '1em', color: i.col || '#000', fontFamily: FF[i.ff || 'sans'] } : { width: `${i.w * 100}%`, aspectRatio: `1 / ${i.ar}` }), pointerEvents: tool === 'move' ? 'auto' : 'none' }}
                  onPointerDown={e => drag(e, p, i, 'mv')}>
                  {(i.t === 'text' || i.t === 'date') && (i.text || ' ')}
                  {i.t === 'image' && <img src={i.src} alt="" draggable={false} />}
                  {i.t === 'check' && <svg viewBox="0 0 10 10"><rect x=".4" y=".4" width="9.2" height="9.2" fill="none" stroke="#000" strokeWidth=".8" />{i.on && <polyline points="2,5.5 4.2,7.8 8.2,2.2" fill="none" stroke="#000" strokeWidth=".8" />}</svg>}
                  {sel?.id === i.id && i.t !== 'text' && i.t !== 'date' && <span className="hd" onPointerDown={e => drag(e, p, i, 'rs')} />}
                </div>)}
              </div></div>)}
          </div>
        </div>
      </div>}

      {crop && PHOTO && <CropView url={PHOTO.url} init={PHOTO.quad || [.08, .08, .92, .08, .92, .92, .08, .92]} onClose={() => setCrop(false)} onDone={applyCrop} />}
      {sig && <SigPad onClose={() => setSig(false)} onDone={(src, ar) => { setSig(false); add(visiblePage(), { t: 'image', w: 0.25, ar, src }); }} />}
    </div>
  );
}

function SigPad({ onClose, onDone }: { onClose: () => void; onDone: (s: string, ar: number) => void }) {
  const ref = useRef<HTMLCanvasElement>(null), down = useRef(false), ink = useRef(false);
  useEffect(() => { const c = ref.current!; c.width = c.clientWidth * 2; c.height = c.clientHeight * 2; }, []);
  const pt = (e: React.PointerEvent) => { const c = ref.current!, r = c.getBoundingClientRect(); return [(e.clientX - r.left) * c.width / r.width, (e.clientY - r.top) * c.height / r.height]; };
  return <div className="modal" role="dialog" aria-label="Draw your signature"><div>
    <canvas ref={ref} onPointerDown={e => { down.current = true; ink.current = true; const g = ref.current!.getContext('2d')!, [x, y] = pt(e); g.lineWidth = 5; g.lineCap = 'round'; g.beginPath(); g.moveTo(x, y); ref.current!.setPointerCapture(e.pointerId); }}
      onPointerMove={e => { if (!down.current) return; const g = ref.current!.getContext('2d')!, [x, y] = pt(e); g.lineTo(x, y); g.stroke(); }} onPointerUp={() => { down.current = false; }} />
    <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
      <button className="btn" onClick={() => { const c = ref.current!; c.getContext('2d')!.clearRect(0, 0, c.width, c.height); ink.current = false; }}>Clear</button>
      <span style={{ flex: 1 }} /><button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn pri" onClick={() => { if (ink.current) onDone(ref.current!.toDataURL('image/png'), ref.current!.height / ref.current!.width); }}>Place signature</button>
    </div></div></div>;
}

function CropView({ url, init, onDone, onClose }: { url: string; init: number[]; onDone: (q: number[]) => void; onClose: () => void }) {
  const [q, setQ] = useState(init), box = useRef<HTMLDivElement>(null);
  const mv = (i: number) => (e: React.PointerEvent<HTMLSpanElement>) => { if (!e.currentTarget.hasPointerCapture(e.pointerId)) return; const r = box.current!.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)); setQ(o => o.map((v, k) => k === 2 * i ? x : k === 2 * i + 1 ? y : v)); };
  return <div className="modal" role="dialog" aria-label="Adjust crop"><div style={{ width: 'min(720px,100%)', maxHeight: '100%', overflow: 'auto' }}>
    <p style={{ margin: '0 0 8px' }}>Drag the four corners onto the corners of the page.</p>
    <div ref={box} style={{ position: 'relative', touchAction: 'none' }}><img src={url} alt="Original photo" style={{ width: '100%', display: 'block' }} draggable={false} />
      <svg viewBox="0 0 1 1" preserveAspectRatio="none" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}><polygon points={[0, 1, 2, 3].map(i => `${q[2 * i]},${q[2 * i + 1]}`).join(' ')} fill="rgba(11,87,208,.2)" stroke="#0b57d0" strokeWidth="3" vectorEffect="non-scaling-stroke" /></svg>
      {[0, 1, 2, 3].map(i => <span key={i} className="hd" role="slider" aria-label={`Corner ${i + 1}`} style={{ left: `${q[2 * i] * 100}%`, top: `${q[2 * i + 1] * 100}%`, right: 'auto', bottom: 'auto', transform: 'translate(-50%,-50%)', width: 32, height: 32 }}
        onPointerDown={e => e.currentTarget.setPointerCapture(e.pointerId)} onPointerMove={mv(i)} />)}
    </div>
    <div style={{ display: 'flex', gap: 8, marginTop: 12, justifyContent: 'flex-end' }}><button className="btn" onClick={onClose}>Cancel</button><button className="btn pri" onClick={() => onDone(q)}>Apply crop</button></div>
  </div></div>;
}
