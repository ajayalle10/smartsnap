'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const { createWorker, createScheduler } = require('tesseract.js');

// Words below this confidence are flagged for the user to check.
const LOW_CONFIDENCE = 60;

// Runs Tesseract in a pool of worker threads so a big batch doesn't block
// the app. Language data is downloaded once, then cached under `cacheDir`.
class OcrEngine {
  constructor(cacheDir) {
    this.cacheDir = cacheDir;
    fs.mkdirSync(cacheDir, { recursive: true });
    this.lang = null;
    this.scheduler = null;
    this.starting = null;
  }

  async ensure(lang) {
    if (this.scheduler && this.lang === lang) return this.scheduler;
    if (this.starting && this.lang === lang) return this.starting;
    if (this.scheduler) await this.scheduler.terminate();
    this.scheduler = null;
    this.lang = lang;
    const count = Math.max(1, Math.min(4, Math.floor(os.cpus().length / 2)));
    this.starting = (async () => {
      const scheduler = createScheduler();
      const workers = await Promise.all(
        Array.from({ length: count }, () => createWorker(lang.split('+'), 1, { cachePath: this.cacheDir }))
      );
      workers.forEach((w) => scheduler.addWorker(w));
      this.scheduler = scheduler;
      this.starting = null;
      return scheduler;
    })();
    return this.starting;
  }

  /**
   * @returns {Promise<{text:string, confidence:number, lowWords:string[]}>}
   */
  async recognize(imagePath, lang) {
    const scheduler = await this.ensure(lang);
    const { data } = await scheduler.addJob('recognize', imagePath, {}, { text: true, blocks: true });
    const lowWords = new Set();
    for (const block of data.blocks || []) {
      for (const para of block.paragraphs) {
        for (const line of para.lines) {
          for (const word of line.words) {
            const w = word.text.trim();
            if (w && word.confidence < LOW_CONFIDENCE) lowWords.add(w);
          }
        }
      }
    }
    return { text: data.text.trim(), confidence: data.confidence, lowWords: [...lowWords] };
  }

  async dispose() {
    if (this.scheduler) await this.scheduler.terminate();
    this.scheduler = null;
  }
}

module.exports = { OcrEngine, LOW_CONFIDENCE };
