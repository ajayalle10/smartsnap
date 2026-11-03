'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { consolidate } = require('../src/shared/consolidate');

test('joins parts with a blank line when there is no overlap', () => {
  const r = consolidate([
    { id: 1, text: 'First page line one\nFirst page line two' },
    { id: 2, text: 'Completely different content here\nAnd more of it' },
  ]);
  assert.strictEqual(r.text, 'First page line one\nFirst page line two\n\nCompletely different content here\nAnd more of it');
  assert.strictEqual(r.junctions.length, 0);
});

test('removes overlapping lines between consecutive shots', () => {
  const r = consolidate([
    { id: 1, text: 'Alpha line about the topic\nBravo line with details\nCharlie line continues here\nDelta line near the bottom' },
    { id: 2, text: 'Charlie line continues here\nDelta line near the bottom\nEcho line is new content\nFoxtrot line ends it' },
  ]);
  assert.strictEqual(r.text, [
    'Alpha line about the topic', 'Bravo line with details',
    'Charlie line continues here', 'Delta line near the bottom',
    'Echo line is new content', 'Foxtrot line ends it',
  ].join('\n'));
  assert.deepStrictEqual(r.junctions, [{ fromId: 1, toId: 2, removedLines: 2 }]);
});

test('tolerates OCR noise and half-cut edge lines', () => {
  const r = consolidate([
    { id: 1, text: 'Intro paragraph text goes here\nThe quick brown fox jumps\nover the lazy dog today\n~~ ,.,; ;;' },
    { id: 2, text: 'ii.. ,\nThe quick brovvn fox jumps\nover the lazy dog today\nFresh line after overlap' },
  ]);
  assert.strictEqual(r.text, 'Intro paragraph text goes here\nThe quick brovvn fox jumps\nover the lazy dog today\nFresh line after overlap');
});

test('does not merge on a short repeated heading', () => {
  const r = consolidate([
    { id: 1, text: 'Some body text in shot one\nSummary' },
    { id: 2, text: 'Summary\nOther body text in shot two' },
  ]);
  assert.strictEqual(r.junctions.length, 0);
});

test('a short photo is never skipped to match the photo before it', () => {
  const r = consolidate([
    { id: 1, text: 'Consecutive shots often overlap here\nYou can copy everything or share it\nEverything runs locally on your phone' },
    { id: 2, text: 'SmartSnap turns photos into text\nCapture several pages with the camera' },
    { id: 3, text: 'You can copy everything or share it\nEverything runs locally on your phone' },
  ]);
  assert.match(r.text, /SmartSnap turns photos into text\nCapture several pages with the camera/);
  assert.deepStrictEqual(r.junctions, []);
});

test('overlap removal can be turned off', () => {
  const t = 'Same line of reasonable length here\nAnother identical line of text';
  const r = consolidate([{ id: 1, text: t }, { id: 2, text: t }], { removeOverlap: false });
  assert.strictEqual(r.text, t + '\n\n' + t);
});
