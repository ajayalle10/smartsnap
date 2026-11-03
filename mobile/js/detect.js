// Finds the corners of a page or screen in a photo, so the crop screen can
// start with them in place. Works on a small copy: blur away the text,
// split light from dark (Otsu), fill in the text holes, take the largest
// region, and accept it only if it really is a four-cornered shape.
// Returns corners [TL, TR, BR, BL] in the input's pixel coords, or null.

import { resized, release } from './imaging.js';

const SIZE = 360;

function otsu(g) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < g.length; i++) hist[g[i]]++;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, t = 128;
  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (!wB) continue;
    const wF = g.length - wB;
    if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; t = i; }
  }
  return t;
}

// Separable box blur, done twice (close to a Gaussian).
function blur(g, w, h, r) {
  const tmp = new Float32Array(w * h);
  const out = new Uint8ClampedArray(w * h);
  const src = Float32Array.from(g);
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < h; y++) {
      let acc = 0;
      for (let x = -r; x <= r; x++) acc += src[y * w + Math.min(w - 1, Math.max(0, x))];
      for (let x = 0; x < w; x++) {
        tmp[y * w + x] = acc / (2 * r + 1);
        acc += src[y * w + Math.min(w - 1, x + r + 1)] - src[y * w + Math.max(0, x - r)];
      }
    }
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let y = -r; y <= r; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
      for (let y = 0; y < h; y++) {
        src[y * w + x] = acc / (2 * r + 1);
        acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
      }
    }
  }
  for (let i = 0; i < src.length; i++) out[i] = src[i];
  return out;
}

// Background pixels not reachable from the image border are holes inside a
// region (text, images on a page): fill them in.
function fillHoles(mask, w, h) {
  const outside = new Uint8Array(w * h);
  const stack = [];
  const push = (i) => { if (!mask[i] && !outside[i]) { outside[i] = 1; stack.push(i); } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (stack.length) {
    const i = stack.pop();
    const x = i % w;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (i >= w) push(i - w);
    if (i < w * (h - 1)) push(i + w);
  }
  for (let i = 0; i < mask.length; i++) if (!outside[i]) mask[i] = 1;
}

// Largest 4-connected region of the mask: its pixel count and the four
// extreme points (min/max of x+y and x−y), which are the corners of a
// roughly upright quadrilateral.
function largestRegion(mask, w, h) {
  const label = new Int32Array(w * h);
  let best = null;
  let next = 1;
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || label[start]) continue;
    const id = next++;
    const stack = [start];
    label[start] = id;
    let count = 0;
    let tl = [0, 0, Infinity], br = [0, 0, -Infinity], tr = [0, 0, -Infinity], bl = [0, 0, Infinity];
    while (stack.length) {
      const i = stack.pop();
      const x = i % w, y = (i / w) | 0;
      count++;
      const s = x + y, d = x - y;
      if (s < tl[2]) tl = [x, y, s];
      if (s > br[2]) br = [x, y, s];
      if (d > tr[2]) tr = [x, y, d];
      if (d < bl[2]) bl = [x, y, d];
      const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
      for (const j of nb) {
        if (j >= 0 && mask[j] && !label[j]) { label[j] = id; stack.push(j); }
      }
    }
    if (!best || count > best.count) {
      best = { id, count, corners: [tl, tr, br, bl].map(([x, y]) => [x, y]) };
    }
  }
  if (best) best.label = label;
  return best;
}

function quadArea(q) {
  let a = 0;
  for (let i = 0; i < 4; i++) {
    const [x1, y1] = q[i], [x2, y2] = q[(i + 1) % 4];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

function isConvex(q) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = q[i], [bx, by] = q[(i + 1) % 4], [cx, cy] = q[(i + 2) % 4];
    const cross = (bx - ax) * (cy - by) - (by - ay) * (cx - bx);
    if (!cross) return false;
    if (sign && Math.sign(cross) !== sign) return false;
    sign = Math.sign(cross);
  }
  return true;
}

export function detectDocument(source) {
  const small = resized(source, SIZE);
  const { width: w, height: h } = small;
  const px = small.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  release(small);
  const gray = new Uint8ClampedArray(w * h);
  for (let i = 0; i < w * h; i++) gray[i] = (px[i * 4] * 77 + px[i * 4 + 1] * 150 + px[i * 4 + 2] * 29) >> 8;
  const g = blur(gray, w, h, 3);
  const t = otsu(g);
  const total = w * h;

  let best = null;
  // A light page/screen on a darker surround, or the other way round
  // (dark-mode screens).
  for (const light of [true, false]) {
    const mask = new Uint8Array(total);
    for (let i = 0; i < total; i++) mask[i] = light ? g[i] > t : g[i] <= t;
    fillHoles(mask, w, h);
    const region = largestRegion(mask, w, h);
    if (!region) continue;
    const q = region.corners;
    const area = quadArea(q);
    const fill = region.count / area;          // ~1 when the region is a clean quad
    const share = area / total;
    const minSide = Math.min(...q.map((p, i) => Math.hypot(p[0] - q[(i + 1) % 4][0], p[1] - q[(i + 1) % 4][1])));
    // A real page/screen is mostly its own colour even before blurring. A
    // block of dense text only looks solid because of the blur; between the
    // letters it's still the other colour.
    let same = 0;
    for (let i = 0; i < total; i++) {
      if (region.label[i] === region.id && (light ? gray[i] > t : gray[i] <= t)) same++;
    }
    const purity = same / region.count;
    const ok = share > 0.15 && share < 0.96 && fill > 0.88 && fill < 1.12 && purity > 0.65 &&
      isConvex(q) && minSide > 0.15 * Math.min(w, h);
    if (ok && (!best || Math.abs(1 - fill) < Math.abs(1 - best.fill))) best = { q, fill };
  }
  if (!best) return null;

  const [sw, sh] = [source.naturalWidth || source.width, source.naturalHeight || source.height];
  const sx = sw / w, sy = sh / h;
  return best.q.map(([x, y]) => [
    Math.min(sw, Math.max(0, (x + 0.5) * sx)),
    Math.min(sh, Math.max(0, (y + 0.5) * sy)),
  ]);
}
