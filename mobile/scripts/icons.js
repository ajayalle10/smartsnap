'use strict';

// Draws the app icon (a scan frame around a page of text) and writes PNGs.
// No image libraries: shapes are rendered with 4x supersampling and encoded
// with zlib.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'icons');

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function png(size, rgba) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Signed distance to a rounded rectangle centred at (cx, cy).
function roundRect(x, y, cx, cy, hw, hh, r) {
  const qx = Math.abs(x - cx) - hw + r, qy = Math.abs(y - cy) - hh + r;
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - r;
}

// Colour of the icon at unit coords (0..1). `pad` shrinks the artwork for
// maskable icons, whose edges get cropped by the launcher.
function shade(u, v, pad) {
  // Map icon space to art space, so the art shrinks toward the centre.
  const inv = (t) => (t - 0.5) / (1 - pad * 2) + 0.5;
  const x = inv(u), y = inv(v);
  // Background: blue, lighter at top.
  let col = [47 + 30 * (1 - v), 111 + 30 * (1 - v), 237];
  // Page.
  const page = roundRect(x, y, 0.5, 0.52, 0.2, 0.26, 0.04);
  if (page < 0) col = [255, 255, 255];
  // Text lines on the page.
  const lines = [[0.38, 0.13], [0.46, 0.13], [0.54, 0.13], [0.62, 0.08]];
  for (const [ly, half] of lines) {
    const lx = 0.5 - 0.13 + half;
    if (roundRect(x, y, lx, ly, half, 0.018, 0.018) < 0) col = [47, 111, 237];
  }
  // Scan-frame corners.
  const t = 0.035, L = 0.12, m = 0.17;
  const corners = [[m, m, 1, 1], [1 - m, m, -1, 1], [m, 1 - m, 1, -1], [1 - m, 1 - m, -1, -1]];
  for (const [cx, cy, dx, dy] of corners) {
    const h = roundRect(x, y, cx + dx * L / 2, cy, L / 2 + t / 2, t / 2, t / 2) < 0;
    const vv = roundRect(x, y, cx, cy + dy * L / 2, t / 2, L / 2 + t / 2, t / 2) < 0;
    if (h || vv) col = [255, 255, 255];
  }
  return col;
}

function render(size, { pad = 0, rounded = false } = {}) {
  const SS = 4;
  const buf = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (px + (sx + 0.5) / SS) / size, v = (py + (sy + 0.5) / SS) / size;
          if (rounded && roundRect(u, v, 0.5, 0.5, 0.5, 0.5, 0.22) > 0) continue;
          const c = shade(u, v, pad);
          r += c[0]; g += c[1]; b += c[2]; a += 1;
        }
      }
      const n = SS * SS, o = (py * size + px) * 4;
      if (a) { buf[o] = r / a; buf[o + 1] = g / a; buf[o + 2] = b / a; }
      buf[o + 3] = Math.round((a / n) * 255);
    }
  }
  return png(size, buf);
}

fs.mkdirSync(OUT, { recursive: true });
// iOS rounds the corners itself, so its icon is a full square.
fs.writeFileSync(path.join(OUT, 'icon-180.png'), render(180));
fs.writeFileSync(path.join(OUT, 'icon-192.png'), render(192, { rounded: true }));
fs.writeFileSync(path.join(OUT, 'icon-512.png'), render(512, { rounded: true }));
fs.writeFileSync(path.join(OUT, 'icon-maskable-512.png'), render(512, { pad: 0.1 }));
console.log('Icons written to', OUT);
