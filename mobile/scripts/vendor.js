'use strict';

// Copies the OCR engine, language data and shared code into mobile/vendor so
// the mobile app is a plain static folder that loads nothing from a CDN.

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const nm = path.join(root, 'node_modules');
const out = path.join(root, 'mobile', 'vendor');

function copy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

fs.rmSync(out, { recursive: true, force: true });

for (const f of ['tesseract.min.js', 'worker.min.js']) {
  copy(path.join(nm, 'tesseract.js', 'dist', f), path.join(out, 'tesseract', f));
}

// We only run the LSTM engine, so only its builds are needed. Tesseract picks
// the SIMD/relaxed-SIMD variant the device supports at runtime.
const coreDir = path.join(nm, 'tesseract.js-core');
for (const f of fs.readdirSync(coreDir).filter((n) => n.endsWith('-lstm.wasm.js'))) {
  copy(path.join(coreDir, f), path.join(out, 'core', f));
}

copy(path.join(nm, '@tesseract.js-data', 'eng', '4.0.0_best_int', 'eng.traineddata.gz'),
  path.join(out, 'lang', 'best', 'eng.traineddata.gz'));
// The "fast" model (from github.com/tesseract-ocr/tessdata_fast) isn't on npm,
// so it is kept in the repo.
copy(path.join(root, 'mobile', 'assets', 'lang', 'fast', 'eng.traineddata.gz'),
  path.join(out, 'lang', 'fast', 'eng.traineddata.gz'));

copy(path.join(root, 'src', 'shared', 'consolidate.js'), path.join(out, 'consolidate.js'));

console.log('Vendored files into', path.relative(root, out));
