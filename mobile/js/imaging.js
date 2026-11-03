// Canvas image helpers: decode, resize, rotate, perspective-flatten, blur check.

export async function decode(blob) {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();   // applies the photo's EXIF rotation
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

const sizeOf = (src) => [src.naturalWidth || src.width, src.naturalHeight || src.height];

export function resized(src, maxSide) {
  const [w0, h0] = sizeOf(src);
  const scale = maxSide ? Math.min(1, maxSide / Math.max(w0, h0)) : 1;
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w0 * scale));
  c.height = Math.max(1, Math.round(h0 * scale));
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  return c;
}

// quarterTurns: clockwise 90° steps.
export function rotated(src, quarterTurns) {
  const q = ((quarterTurns % 4) + 4) % 4;
  const [w, h] = sizeOf(src);
  const c = document.createElement('canvas');
  c.width = q % 2 ? h : w;
  c.height = q % 2 ? w : h;
  const ctx = c.getContext('2d');
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate((q * Math.PI) / 2);
  ctx.drawImage(src, -w / 2, -h / 2);
  return c;
}

export function grayscale(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const px = data.data;
  for (let i = 0; i < px.length; i += 4) {
    const g = (px[i] * 77 + px[i + 1] * 150 + px[i + 2] * 29) >> 8;
    px[i] = px[i + 1] = px[i + 2] = g;
  }
  ctx.putImageData(data, 0, 0);
  return canvas;
}

// Evens out lighting on a greyscale canvas (in place) before OCR: estimates
// the page background brightness across the photo, divides it out (removes
// glare, shadows and the bright-centre/dark-edge look of monitor photos),
// then stretches contrast. Light-on-dark text (dark mode) is inverted first.
export function cleanForOcr(canvas) {
  const { width: w, height: h } = canvas;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, w, h);
  const px = img.data;
  const n = w * h;

  let mean = 0;
  for (let i = 0; i < n; i++) mean += px[i * 4];
  mean /= n;
  if (mean < 110) for (let i = 0; i < n; i++) px[i * 4] = 255 - px[i * 4];

  // Background: shrink a lot (letters vanish), take the local maximum so
  // dark text doesn't pull it down, then let the canvas scale it back up
  // smoothly.
  const bw = Math.max(4, Math.round(w / 24)), bh = Math.max(4, Math.round(h / 24));
  const g = document.createElement('canvas');
  g.width = w; g.height = h;
  const gctx = g.getContext('2d', { willReadFrequently: true });
  const gi = gctx.createImageData(w, h);
  for (let i = 0; i < n; i++) { const v = px[i * 4]; gi.data[i * 4] = gi.data[i * 4 + 1] = gi.data[i * 4 + 2] = v; gi.data[i * 4 + 3] = 255; }
  gctx.putImageData(gi, 0, 0);
  const s = document.createElement('canvas');
  s.width = bw; s.height = bh;
  const sctx = s.getContext('2d', { willReadFrequently: true });
  sctx.imageSmoothingQuality = 'high';
  sctx.drawImage(g, 0, 0, bw, bh);
  const sd = sctx.getImageData(0, 0, bw, bh);
  const small = new Uint8ClampedArray(bw * bh);
  for (let i = 0; i < bw * bh; i++) small[i] = sd.data[i * 4];
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      let m = 0;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const yy = Math.min(bh - 1, Math.max(0, y + dy)), xx = Math.min(bw - 1, Math.max(0, x + dx));
          m = Math.max(m, small[yy * bw + xx]);
        }
      }
      const o = (y * bw + x) * 4;
      sd.data[o] = sd.data[o + 1] = sd.data[o + 2] = m;
    }
  }
  sctx.putImageData(sd, 0, 0);
  gctx.imageSmoothingQuality = 'high';
  gctx.drawImage(s, 0, 0, w, h);
  const bg = gctx.getImageData(0, 0, w, h).data;
  release(g, s);

  // Divide out the background, then stretch so the darkest ~1% is black.
  const flat = new Uint8ClampedArray(n);
  const hist = new Uint32Array(256);
  for (let i = 0; i < n; i++) {
    const v = Math.min(255, (px[i * 4] / Math.max(bg[i * 4], 1)) * 245);
    flat[i] = v;
    hist[flat[i]]++;
  }
  let lo = 0;
  for (let acc = 0; lo < 255 && acc + hist[lo] < n * 0.01; lo++) acc += hist[lo];
  const span = Math.max(1, 245 - lo);
  for (let i = 0; i < n; i++) {
    const v = ((flat[i] - lo) / span) * 255;
    px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

// iPhone Safari caps the total memory of all canvases and frees a canvas's
// memory only when it's garbage-collected. Past the cap, drawing silently
// produces nothing. Shrinking a canvas to 0×0 frees its memory right away.
export function release(...canvases) {
  for (const c of canvases) {
    if (c instanceof HTMLCanvasElement) c.width = c.height = 0;
  }
}

export function toBlob(canvas, type = 'image/jpeg', quality = 0.9) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode image'))), type, quality);
  });
}

// Homography mapping the rectangle (0,0)-(w,h) onto quad pts (TL, TR, BR, BL).
function homography(pts, w, h) {
  const dst = [[0, 0], [w, 0], [w, h], [0, h]];
  const A = [];
  for (let i = 0; i < 4; i++) {
    const [u, v] = dst[i];
    const [x, y] = pts[i];
    A.push([u, v, 1, 0, 0, 0, -u * x, -v * x, x]);
    A.push([0, 0, 0, u, v, 1, -u * y, -v * y, y]);
  }
  for (let col = 0; col < 8; col++) {
    let pivot = col;
    for (let r = col + 1; r < 8; r++) if (Math.abs(A[r][col]) > Math.abs(A[pivot][col])) pivot = r;
    [A[col], A[pivot]] = [A[pivot], A[col]];
    const p = A[col][col];
    if (Math.abs(p) < 1e-12) throw new Error('The corners are too close together');
    for (let k = col; k < 9; k++) A[col][k] /= p;
    for (let r = 0; r < 8; r++) {
      if (r === col) continue;
      const f = A[r][col];
      if (!f) continue;
      for (let k = col; k < 9; k++) A[r][k] -= f * A[col][k];
    }
  }
  return A.map((row) => row[8]);
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

export function isFullQuad(pts, w, h) {
  const full = [[0, 0], [w, 0], [w, h], [0, h]];
  return pts.every((p, i) => Math.abs(p[0] - full[i][0]) < 1 && Math.abs(p[1] - full[i][1]) < 1);
}

// Cuts the quad out of `source` and flattens it to a rectangle.
export function warpQuad(source, pts) {
  const [sw, sh] = sizeOf(source);
  // Plain rectangle: a simple crop is much faster than per-pixel warping.
  const axisAligned = pts[0][1] === pts[1][1] && pts[2][1] === pts[3][1] && pts[0][0] === pts[3][0] && pts[1][0] === pts[2][0];
  if (axisAligned) {
    const c = document.createElement('canvas');
    c.width = Math.round(pts[1][0] - pts[0][0]);
    c.height = Math.round(pts[3][1] - pts[0][1]);
    c.getContext('2d').drawImage(source, pts[0][0], pts[0][1], c.width, c.height, 0, 0, c.width, c.height);
    return c;
  }
  const w = Math.round(Math.max(dist(pts[0], pts[1]), dist(pts[3], pts[2])));
  const h = Math.round(Math.max(dist(pts[0], pts[3]), dist(pts[1], pts[2])));
  const H = homography(pts, w, h);
  const srcCanvas = source instanceof HTMLCanvasElement ? source : resized(source, 0);
  const src = srcCanvas.getContext('2d').getImageData(0, 0, sw, sh).data;
  if (srcCanvas !== source) release(srcCanvas);
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const octx = out.getContext('2d');
  const img = octx.createImageData(w, h);
  const d = img.data;
  for (let v = 0; v < h; v++) {
    for (let u = 0; u < w; u++) {
      const z = H[6] * u + H[7] * v + 1;
      let x = (H[0] * u + H[1] * v + H[2]) / z;
      let y = (H[3] * u + H[4] * v + H[5]) / z;
      x = Math.min(Math.max(x, 0), sw - 1.001);
      y = Math.min(Math.max(y, 0), sh - 1.001);
      const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0;
      const i00 = (y0 * sw + x0) * 4, i10 = i00 + 4, i01 = i00 + sw * 4, i11 = i01 + 4;
      const o = (v * w + u) * 4;
      for (let c = 0; c < 3; c++) {
        const top = src[i00 + c] + (src[i10 + c] - src[i00 + c]) * fx;
        const bot = src[i01 + c] + (src[i11 + c] - src[i01 + c]) * fx;
        d[o + c] = top + (bot - top) * fy;
      }
      d[o + 3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);
  return out;
}

// Variance of the Laplacian on a small greyscale copy: low = few sharp edges
// = probably blurry.
export const BLUR_THRESHOLD = 60;
export function blurScore(src) {
  const c = resized(src, 800);
  const { width: w, height: h } = c;
  const px = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  release(c);
  const g = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
  let sum = 0, sumSq = 0, n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const lap = g[i - 1] + g[i + 1] + g[i - w] + g[i + w] - 4 * g[i];
      sum += lap; sumSq += lap * lap; n++;
    }
  }
  const mean = sum / n;
  return n ? sumSq / n - mean * mean : 0;
}
