import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
export const runtime = 'nodejs';
// Mints a short-lived HMAC token. PROCESSOR_SECRET never leaves the server; the browser only holds the 10-minute token.
export async function POST(req: Request) {
  const secret = process.env.PROCESSOR_SECRET, base = process.env.PROCESSOR_URL, code = process.env.APP_ACCESS_CODE;
  const no = (s: number) => Response.json({ error: 'unavailable' }, { status: s, headers: { 'Cache-Control': 'no-store' } });
  if (!secret || !base) return no(503);
  if (code) { const a = Buffer.from(req.headers.get('x-access-code') || ''), b = Buffer.from(code); if (a.length !== b.length || !timingSafeEqual(a, b)) return no(401); }
  const exp = Math.floor(Date.now() / 1000) + 600;
  const p = Buffer.from(JSON.stringify({ exp, n: randomBytes(8).toString('hex') })).toString('base64url');
  const token = `${p}.${createHmac('sha256', secret).update(p).digest('base64url')}`;
  return Response.json({ token, exp, base: base.replace(/\/$/, '') }, { headers: { 'Cache-Control': 'no-store' } });
}
