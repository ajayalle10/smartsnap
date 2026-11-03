'use strict';

// Merges OCR text from an ordered list of images into one document,
// removing the content that overlaps between consecutive shots
// (e.g. photos taken while scrolling down a long page).

const MAX_OVERLAP_LINES = 40;
// Lines at the edge of a hand-held photo are often cut in half and OCR as junk,
// so we allow skipping a few of them on each side of a junction.
const MAX_EDGE_SKIP = 2;
const LINE_SIMILARITY = 0.8;

function normalize(line) {
  return line.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Array(b.length + 1);
  let cur = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

function similarity(a, b) {
  if (!a && !b) return 1;
  const len = Math.max(a.length, b.length);
  return 1 - levenshtein(a, b) / len;
}

function toLines(text) {
  return text.replace(/\r\n?/g, '\n').split('\n');
}

// Non-empty lines with their index in the original line array, so blank
// lines (paragraph breaks) don't break up a match.
function contentLines(lines) {
  const out = [];
  lines.forEach((raw, idx) => {
    const norm = normalize(raw);
    if (norm) out.push({ idx, norm });
  });
  return out;
}

// Finds the longest run of lines at the end of `prev` that also appears at the
// start of `next`. Returns { prevCut, nextStart, lines } in original line
// indices, or null when there is no convincing overlap.
function findOverlap(prevLines, nextLines) {
  const a = contentLines(prevLines);
  const b = contentLines(nextLines);
  let best = null;

  for (let skipA = 0; skipA <= MAX_EDGE_SKIP; skipA++) {
    for (let skipB = 0; skipB <= MAX_EDGE_SKIP; skipB++) {
      const maxK = Math.min(a.length - skipA, b.length - skipB, MAX_OVERLAP_LINES);
      for (let k = maxK; k >= 1; k--) {
        if (best && k <= best.k) break;
        const aStart = a.length - skipA - k;
        let total = 0;
        let ok = true;
        for (let t = 0; t < k; t++) {
          const s = similarity(a[aStart + t].norm, b[skipB + t].norm);
          if (s < LINE_SIMILARITY) { ok = false; break; }
          total += s;
        }
        if (!ok) continue;
        // A single matching line only counts if it is long enough to be
        // unlikely to repeat by chance (e.g. not a heading like "Summary").
        const chars = b.slice(skipB, skipB + k).reduce((n, l) => n + l.norm.length, 0);
        if (k === 1 && chars < 25) continue;
        best = {
          k,
          score: total / k,
          prevCut: a[aStart].idx,                 // keep prev lines [0, prevCut)
          nextStart: b[skipB].idx,                // overlap begins here in next
        };
        break;
      }
    }
  }
  return best;
}

function trimBlankEdges(lines) {
  let s = 0;
  let e = lines.length;
  while (s < e && !lines[s].trim()) s++;
  while (e > s && !lines[e - 1].trim()) e--;
  return lines.slice(s, e);
}

/**
 * @param {{id:number, text:string}[]} parts  OCR text in document order
 * @param {{removeOverlap?: boolean}} opts
 * @returns {{text:string, junctions:{fromId:number,toId:number,removedLines:number}[]}}
 */
function consolidate(parts, opts = {}) {
  const removeOverlap = opts.removeOverlap !== false;
  const junctions = [];
  let doc = [];
  let prevId = null;

  for (const part of parts) {
    const lines = trimBlankEdges(toLines(part.text || ''));
    if (!lines.length) continue;

    if (removeOverlap && doc.length) {
      // Only look at the tail of the document so far: overlap is between
      // neighbouring shots, not with something far back.
      const tailStart = Math.max(0, doc.length - MAX_OVERLAP_LINES * 2);
      const overlap = findOverlap(doc.slice(tailStart), lines);
      if (overlap) {
        const removed = contentLines(doc.slice(tailStart + overlap.prevCut)).length;
        // Keep next's version of the overlapping lines: the earlier shot tends
        // to have the partially-cut lines at its bottom edge.
        doc = trimBlankEdges(doc.slice(0, tailStart + overlap.prevCut));
        // No blank line here: the cut is mid-flow, so the text continues as-is.
        doc.push(...lines.slice(overlap.nextStart));
        junctions.push({ fromId: prevId, toId: part.id, removedLines: removed });
        prevId = part.id;
        continue;
      }
    }

    if (doc.length) doc.push('');
    doc.push(...lines);
    prevId = part.id;
  }

  return { text: doc.join('\n'), junctions };
}

// Used by both Node (desktop app, tests) and the browser (mobile web app).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { consolidate, findOverlap, similarity, normalize };
} else {
  self.Consolidate = { consolidate };
}
