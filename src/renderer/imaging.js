'use strict';

// Canvas-based image helpers: rotation, perspective flattening and a blur
// estimate. No OpenCV needed for these.
window.Imaging = (() => {
  // CORS so the pixels can be read back from a canvas.
  function loadImageCors(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Could not load image'));
      img.src = url;
    });
  }

  // quarterTurns: 0..3, clockwise.
  function rotated(source, quarterTurns) {
    const q = ((quarterTurns % 4) + 4) % 4;
    const w = source.naturalWidth || source.width;
    const h = source.naturalHeight || source.height;
    const c = document.createElement('canvas');
    c.width = q % 2 ? h : w;
    c.height = q % 2 ? w : h;
    const ctx = c.getContext('2d');
    ctx.translate(c.width / 2, c.height / 2);
    ctx.rotate((q * Math.PI) / 2);
    ctx.drawImage(source, -w / 2, -h / 2);
    return c;
  }

  // Solves the 8x8 system for the homography that maps the rectangle
  // (0,0)-(w,h) onto the quad `pts` (TL, TR, BR, BL).
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
      if (Math.abs(p) < 1e-12) throw new Error('Corners are degenerate');
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

  // Cuts the quad out of `source` (a canvas) and flattens it to a rectangle,
  // sampling with bilinear interpolation.
  function warpQuad(source, pts) {
    const w = Math.round(Math.max(dist(pts[0], pts[1]), dist(pts[3], pts[2])));
    const h = Math.round(Math.max(dist(pts[0], pts[3]), dist(pts[1], pts[2])));
    const H = homography(pts, w, h);
    const sw = source.width;
    const sh = source.height;
    const src = source.getContext('2d').getImageData(0, 0, sw, sh).data;
    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    const octx = out.getContext('2d');
    const dstImg = octx.createImageData(w, h);
    const d = dstImg.data;
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
    octx.putImageData(dstImg, 0, 0);
    return out;
  }

  // Variance of the Laplacian on a downscaled greyscale copy. Low values mean
  // few sharp edges, i.e. a blurry photo. Text photos that are in focus
  // usually score well above BLUR_THRESHOLD.
  const BLUR_THRESHOLD = 60;
  function blurScore(img) {
    const max = 800;
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(3, Math.round(img.naturalWidth * scale));
    const h = Math.max(3, Math.round(img.naturalHeight * scale));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    const px = ctx.getImageData(0, 0, w, h).data;
    const g = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) g[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
    let sum = 0, sumSq = 0, n = 0;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const lap = g[i - 1] + g[i + 1] + g[i - w] + g[i + w] - 4 * g[i];
        sum += lap;
        sumSq += lap * lap;
        n++;
      }
    }
    const mean = sum / n;
    return sumSq / n - mean * mean;
  }

  function canvasToPngBytes(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(async (blob) => {
        if (!blob) return reject(new Error('Could not encode image'));
        resolve(new Uint8Array(await blob.arrayBuffer()));
      }, 'image/png');
    });
  }

  return { loadImageCors, rotated, warpQuad, blurScore, BLUR_THRESHOLD, canvasToPngBytes };
})();
