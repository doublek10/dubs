// Validates by content (never filename/MIME). Nothing is written to disk. DOC/DOCX are converted via an external service.
export const runtime = 'nodejs';
export const maxDuration = 60;
const MAX = 4 * 1024 * 1024; // Vercel request body limit is ~4.5 MB
const eq = (b: Uint8Array, s: number[], o = 0) => s.every((v, i) => b[o + i] === v);
function sniff(b: Uint8Array) {
  if (eq(b, [0x25, 0x50, 0x44, 0x46])) return 'pdf';
  if (eq(b, [0x89, 0x50, 0x4e, 0x47])) return 'image';
  if (eq(b, [0xff, 0xd8, 0xff])) return 'image';
  if (eq(b, [0x52, 0x49, 0x46, 0x46]) && eq(b, [0x57, 0x45, 0x42, 0x50], 8)) return 'image';
  if (eq(b, [0x66, 0x74, 0x79, 0x70], 4)) return 'heic';
  if (eq(b, [0x50, 0x4b, 0x03, 0x04])) return 'docx';
  if (eq(b, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return 'doc';
  return null;
}
const err = (m: string, s = 400) => Response.json({ ok: false, error: m }, { status: s, headers: { 'Cache-Control': 'no-store' } });
export async function POST(req: Request) {
  try {
    const f = await req.formData();
    const head = f.get('head'), file = f.get('file');
    if (!(head instanceof Blob)) return err('We couldn’t read this document.');
    const kind = sniff(new Uint8Array(await head.arrayBuffer()));
    if (!kind) return err('This file type isn’t supported. Use PDF, DOC, DOCX, JPG, PNG or WEBP.');
    if (kind !== 'doc' && kind !== 'docx') return Response.json({ ok: true, kind }, { headers: { 'Cache-Control': 'no-store' } });
    if (!(file instanceof Blob) || file.size > MAX) return err('This Word document is too large to process (limit 4 MB).');
    const url = process.env.CONVERT_SERVICE_URL;
    if (!url) return err('Word documents aren’t available on this deployment yet. Upload a PDF or image instead.', 501);
    const fd = new FormData(); fd.append('file', file, kind === 'doc' ? 'in.doc' : 'in.docx');
    const r = await fetch(url, { method: 'POST', body: fd, headers: process.env.CONVERT_SERVICE_KEY ? { Authorization: `Bearer ${process.env.CONVERT_SERVICE_KEY}` } : {}, signal: AbortSignal.timeout(50000) });
    if (!r.ok) return err('We couldn’t convert this document.', 502);
    return new Response(await r.arrayBuffer(), { headers: { 'Content-Type': 'application/pdf', 'Cache-Control': 'no-store' } });
  } catch { return err('We couldn’t read this document. It may be corrupted or unsupported.'); }
}
