const PROC = new URL(process.env.PROCESSOR_URL || 'https://api.wonderbizz.top/v3').origin;
const headers = [
  { key: 'X-Robots-Tag', value: 'noindex, nofollow, noarchive' },
  { key: 'Cache-Control', value: 'no-store' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'Content-Security-Policy', value: `default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self' data: blob: ${PROC}; frame-ancestors 'none'` },
];
export default {
  async headers() { return [{ source: '/:path*', headers }]; },
  webpack(c) { c.resolve.alias.canvas = false; return c; },
};
