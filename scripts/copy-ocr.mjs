import fs from 'fs'; import path from 'path';
const out = 'public/tesseract'; fs.mkdirSync(out, { recursive: true });
const walk = d => fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]) : [];
for (const f of walk('node_modules/tesseract.js-core')) if (/^tesseract-core.*\.(js|wasm)$/.test(path.basename(f))) fs.copyFileSync(f, path.join(out, path.basename(f)));
fs.copyFileSync('node_modules/tesseract.js/dist/worker.min.js', path.join(out, 'worker.min.js'));
fs.copyFileSync(walk('node_modules/@tesseract.js-data/eng').find(f => f.endsWith('eng.traineddata.gz')), path.join(out, 'eng.traineddata.gz'));
