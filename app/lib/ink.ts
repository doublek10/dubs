// Pure pixel algorithms (no DOM) so they can run in the browser and be tested in Node.
export const LUM = (r: number, g: number, b: number) => (r * 3 + g * 6 + b) / 10;
export function clampBox(r: number[], W: number, H: number) {
  const x0 = Math.max(0, Math.floor(r[0] * W)), y0 = Math.max(0, Math.floor(r[1] * H)), x1 = Math.min(W - 1, Math.ceil((r[0] + r[2]) * W)), y1 = Math.min(H - 1, Math.ceil((r[1] + r[3]) * H));
  return { x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}
function medRow(d: Uint8ClampedArray, W: number, H: number, x0: number, x1: number, y: number) { // paper colour just outside a box
  y = Math.min(H - 1, Math.max(0, y)); const c: number[][] = [[], [], []];
  for (let x = x0; x <= x1; x += 3) { const o = (y * W + x) * 4; c[0].push(d[o]); c[1].push(d[o + 1]); c[2].push(d[o + 2]); }
  return c.map(a => a.sort((p, q) => p - q)[a.length >> 1]);
}
const bgAt = (T: number[], B: number[], j: number, h: number) => { const t = j / Math.max(1, h - 1); return [0, 1, 2].map(q => T[q] + (B[q] - T[q]) * t); };
const sat = (d: Uint8ClampedArray, o: number) => Math.max(d[o], d[o + 1], d[o + 2]) - Math.min(d[o], d[o + 1], d[o + 2]);

/** Remove ONLY coloured-pen pixels (blue/red/green ink, stamps) inside a box. Black print is never touched. */
export function penErase(d: Uint8ClampedArray, W: number, H: number, r: number[]) {
  const { x0, y0, x1, y1, w, h } = clampBox(r, W, H); if (w < 3 || h < 3) return;
  const T = medRow(d, W, H, x0, x1, y0 - 3), B = medRow(d, W, H, x0, x1, y1 + 3), st = new Uint8Array(w * h), wk = new Uint8Array(w * h), dk = new Uint8Array(w * h), fin = new Uint8Array(w * h);
  for (let j = 0; j < h; j++) { const bg = bgAt(T, B, j, h), bs = Math.max(...bg) - Math.min(...bg);
    for (let i = 0; i < w; i++) { const o = ((y0 + j) * W + x0 + i) * 4, s = sat(d, o), lm = LUM(d[o], d[o + 1], d[o + 2]), k = j * w + i; // print is ~neutral (sat<=6); pen has a coloured fringe
      if (s > bs + 12 && lm < 215) st[k] = 1; else if (lm < 160) dk[k] = 1; else if (s > bs + 3) wk[k] = 1; } } // dark+neutral = core or print (short reach); light+tinted = haze (long reach)
  { const lab = new Uint8Array(w * h); // a connected stroke carrying coloured fringe is pen as a whole (its core can be pure black); huge joined shapes (rules/frames) are skipped
    for (let k0 = 0; k0 < w * h; k0++) { if (lab[k0] || !(st[k0] || dk[k0])) continue; const comp = [k0]; lab[k0] = 1; let sc = 0;
      for (let ci = 0; ci < comp.length; ci++) { const k = comp[ci], i = k % w, j = (k / w) | 0; if (st[k]) sc++;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const a = i + dx, b = j + dy; if (a < 0 || b < 0 || a >= w || b >= h) continue; const nk = b * w + a; if (!lab[nk] && (st[nk] || dk[nk])) { lab[nk] = 1; comp.push(nk); } } }
      if (comp.length <= 6000 && sc >= 3 && sc / comp.length >= 0.005) for (const k of comp) fin[k] = 1; } }
  const dist = new Int8Array(w * h).fill(-1), q: number[] = []; // flood from the coloured fringe through the near-black core, max 8px
  for (let k = 0; k < w * h; k++) if (st[k]) { fin[k] = 1; dist[k] = 0; q.push(k); }
  for (let qi = 0; qi < q.length; qi++) { const k = q[qi], i = k % w, j = (k / w) | 0, dd = dist[k]; if (dd >= 14) continue;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const a = i + dx, b = j + dy; if (a < 0 || b < 0 || a >= w || b >= h) continue; const nk = b * w + a;
      if (dist[nk] < 0 && ((dk[nk] && dd < 3) || wk[nk])) { dist[nk] = dd + 1; fin[nk] = 1; q.push(nk); } } }
  const px = (i: number, j: number) => ((y0 + j) * W + x0 + i) * 4, wr: number[][] = [];
  const paper = (i: number, j: number) => { let n = 0, r = 0, g = 0, b = 0; // nearest clean paper pixel in each direction -> blends with local shading
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) for (let a = 1; a <= 16; a++) { const x = i + dx * a, y = j + dy * a; if (x < 0 || y < 0 || x >= w || y >= h) break;
      if (fin[y * w + x]) continue; const o = px(x, y); if (LUM(d[o], d[o + 1], d[o + 2]) > 160) { r += d[o]; g += d[o + 1]; b += d[o + 2]; n++; break; } }
    return n ? [r / n, g / n, b / n] : null; };
  for (let j = 0; j < h; j++) { const bg = bgAt(T, B, j, h);
    for (let i = 0; i < w; i++) { if (!fin[j * w + i]) continue; let L = -1, R = -1;
      for (let a = 1; a <= 6 && L < 0; a++) if (i - a >= 0 && !fin[j * w + i - a]) L = i - a;
      for (let a = 1; a <= 6 && R < 0; a++) if (i + a < w && !fin[j * w + i + a]) R = i + a;
      let c = paper(i, j) || bg; // pen crossing a printed rule/stroke: continue the dark pixels on both sides
      if (L >= 0 && R >= 0) { const p = px(L, j), q = px(R, j); if (LUM(d[p], d[p + 1], d[p + 2]) < 110 && LUM(d[q], d[q + 1], d[q + 2]) < 110) c = [0, 1, 2].map(k => (d[p + k] + d[q + k]) / 2); }
      wr.push([px(i, j), c[0], c[1], c[2]]); } }
  for (const [o, a, b, c] of wr) { d[o] = a; d[o + 1] = b; d[o + 2] = c; }
}

function lineFlags(n: number[], min: number, maxT: number) { // (almost) fully inked rows/cols = printed rules
  const c = n.length, f = n.map(v => v >= min);
  for (let i = 0; i < c;) { if (!f[i]) { i++; continue; } let j = i; while (j < c && f[j]) j++; if (j - i > maxT) for (let k = i; k < j; k++) f[k] = false; i = j; }
  return f.map((v, i) => v || !!f[i - 1] || !!f[i + 1]);
}
/** Manual eraser: removes any ink in the box (incl. black) but keeps printed lines. */
export function eraseRect(d: Uint8ClampedArray, W: number, H: number, r: number[]) {
  const { x0, y0, x1, y1, w, h } = clampBox(r, W, H); if (w < 3 || h < 3) return;
  const T = medRow(d, W, H, x0, x1, y0 - 3), B = medRow(d, W, H, x0, x1, y1 + 3), ink = new Uint8Array(w * h), pen = new Uint8Array(w * h);
  const rn = new Array(h).fill(0), cn = new Array(w).fill(0), rc = Array.from({ length: h }, () => [0, 0, 0]);
  for (let j = 0; j < h; j++) { const bg = bgAt(T, B, j, h), bl = LUM(bg[0], bg[1], bg[2]), bs = Math.max(...bg) - Math.min(...bg);
    for (let i = 0; i < w; i++) { const o = ((y0 + j) * W + x0 + i) * 4, s = sat(d, o), p = s > 55 && s > bs + 30, k = j * w + i;
      if (p || Math.abs(LUM(d[o], d[o + 1], d[o + 2]) - bl) > 38) ink[k] = 1; if (p) pen[k] = 1;
      if (ink[k] && !p) { rn[j]++; cn[i]++; rc[j][0] += d[o]; rc[j][1] += d[o + 1]; rc[j][2] += d[o + 2]; } } }
  const lr = lineFlags(rn, 0.85 * w, Math.max(5, Math.floor(H * 0.004))), lc = lineFlags(cn, 0.85 * h, Math.max(5, Math.floor(W * 0.004)));
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) { let hit = false;
    for (let dy = -1; dy <= 1 && !hit; dy++) for (let dx = -1; dx <= 1; dx++) { const a = i + dx, b = j + dy; if (a >= 0 && b >= 0 && a < w && b < h && ink[b * w + a]) { hit = true; break; } }
    if (!hit) continue; const k = j * w + i, isl = lr[j] || lc[i]; if (isl && !pen[k]) continue;
    const c = lr[j] && rn[j] > 0 ? rc[j].map(v => v / rn[j]) : bgAt(T, B, j, h), o = ((y0 + j) * W + x0 + i) * 4; d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; }
}

/** Find every region of coloured ink on a page -> boxes (fractions). */
export function penBoxesFrom(d: Uint8ClampedArray, W: number, H: number): number[][] {
  const cs = Math.max(8, Math.floor(Math.max(W, H) / 90)), gw = Math.ceil(W / cs), gh = Math.ceil(H / cs), cnt = new Map<number, number>();
  for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) { const o = (y * W + x) * 4; if (LUM(d[o], d[o + 1], d[o + 2]) < 215 && sat(d, o) > 12) { const k = Math.floor(y / cs) * gw + Math.floor(x / cs); cnt.set(k, (cnt.get(k) || 0) + 1); } }
  const act = new Set([...cnt].filter(([, v]) => v >= 3).map(([k]) => k)), seen = new Set<number>(), out: number[][] = [];
  for (const k0 of act) { if (seen.has(k0)) continue; seen.add(k0); const st = [k0]; let mnx = 1e9, mny = 1e9, mxx = -1, mxy = -1, n = 0;
    while (st.length) { const k = st.pop()!, cx = k % gw, cy = Math.floor(k / gw); n += cnt.get(k)!; mnx = Math.min(mnx, cx); mxx = Math.max(mxx, cx); mny = Math.min(mny, cy); mxy = Math.max(mxy, cy);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const nx = cx + dx, ny = cy + dy; if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue; const nk = ny * gw + nx; if (act.has(nk) && !seen.has(nk)) { seen.add(nk); st.push(nk); } } }
    if (n >= 10) { const bx = Math.max(0, mnx * cs - 6), by = Math.max(0, mny * cs - 6); out.push([bx / W, by / H, Math.min(W - bx, (mxx - mnx + 1) * cs + 12) / W, Math.min(H - by, (mxy - mny + 1) * cs + 12) / H]); } }
  return out;
}
