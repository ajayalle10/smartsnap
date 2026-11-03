// OCR queue. Photos are prepared one at a time on the main thread (shrink +
// greyscale) and read in parallel by a pool of Tesseract workers, so reading
// happens while you keep taking photos.

import * as db from './db.js';
import { decode, resized, grayscale, toBlob } from './imaging.js';

const abs = (p) => new URL(p, location.href).href;
const LOW_CONFIDENCE = 60;

const engine = { scheduler: null, ready: null, key: '' };
let settings = { model: 'fast', maxSide: '1600', workers: '2' };
let listener = () => {};
let prepChain = Promise.resolve();
const tokens = new Map();   // photoId -> token of the latest request

export function configure(next, onUpdate) {
  settings = { ...settings, ...next };
  if (onUpdate) listener = onUpdate;
  return start();
}

export function onStatus(fn) { engine.onStatus = fn; }

function status(text, kind) { engine.onStatus?.(text, kind); }

export function start() {
  const key = `${settings.model}/${settings.workers}`;
  if (engine.key === key && engine.ready) return engine.ready;
  const old = engine.scheduler;
  engine.key = key;
  engine.scheduler = null;
  status('Loading OCR…');
  engine.ready = (async () => {
    if (old) await old.terminate();
    const scheduler = Tesseract.createScheduler();
    const options = {
      workerPath: abs('vendor/tesseract/worker.min.js'),
      corePath: abs('vendor/core/'),
      langPath: abs(`vendor/lang/${settings.model}`),
      cachePath: settings.model,
      workerBlobURL: false,
    };
    const workers = await Promise.all(
      Array.from({ length: Number(settings.workers) }, () => Tesseract.createWorker('eng', 1, options))
    );
    workers.forEach((w) => scheduler.addWorker(w));
    if (engine.key === key) {
      engine.scheduler = scheduler;
      status('Ready', 'ready');
    }
    return scheduler;
  })().catch((err) => {
    status('OCR failed to load', 'err');
    throw err;
  });
  return engine.ready;
}

function lowConfidenceWords(data) {
  const out = new Set();
  for (const block of data.blocks || []) {
    for (const para of block.paragraphs) {
      for (const line of para.lines) {
        for (const word of line.words) {
          const w = word.text.trim();
          if (w && word.confidence < LOW_CONFIDENCE) out.add(w);
        }
      }
    }
  }
  return [...out];
}

// Queue a photo for reading. A newer request for the same photo (after an
// edit or "Read again") makes any older one's result be ignored.
export function enqueue(photoId) {
  const token = {};
  tokens.set(photoId, token);
  prepChain = prepChain.then(async () => {
    if (tokens.get(photoId) !== token) return;
    try {
      const photo = await db.getPhoto(photoId);
      if (!photo) return;
      listener(await db.updatePhoto(photoId, { status: 'reading' }));
      const img = await decode(photo.edited || photo.image);
      const blob = await toBlob(grayscale(resized(img, Number(settings.maxSide))), 'image/jpeg', 0.92);
      const scheduler = await start();
      const t0 = performance.now();
      // Not awaited: the next photo gets prepared while this one is read.
      scheduler.addJob('recognize', blob, {}, { text: true, blocks: true }).then(async ({ data }) => {
        if (tokens.get(photoId) !== token) return;
        tokens.delete(photoId);
        const updated = await db.updatePhoto(photoId, {
          status: 'done', text: data.text.trim(), conf: data.confidence,
          lowWords: lowConfidenceWords(data), ocrMs: performance.now() - t0, textEdited: false,
        });
        if (updated) listener(updated);
      }).catch((err) => fail(photoId, token, err));
    } catch (err) {
      fail(photoId, token, err);
    }
  });
}

async function fail(photoId, token, err) {
  if (tokens.get(photoId) !== token) return;
  tokens.delete(photoId);
  const updated = await db.updatePhoto(photoId, { status: 'error', text: String(err?.message || err) });
  if (updated) listener(updated);
}

export function cancel(photoId) {
  tokens.delete(photoId);
}
