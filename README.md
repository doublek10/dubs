# Document Duplicator
`npm i && npm run dev` — deploy to Vercel as-is (framework: Next.js).
- Documents are processed **in the browser**; nothing is stored server-side. Closing/finishing clears memory.
- `/api/ingest` validates file content (magic bytes) server-side and never writes to disk.
- Heavy work runs on the PHP processor in `php-api/` (see `php-api/DEPLOY.md`). `/api/token` mints short-lived HMAC tokens; the secret stays server-side.
