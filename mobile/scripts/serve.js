'use strict';

// Serves the mobile app on your Wi-Fi so you can open it on your iPhone.
// Prints the address and a QR code to scan with the iPhone camera.

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const QRCode = require('qrcode');

const PORT = Number(process.env.PORT) || 5180;
const root = path.join(__dirname, '..');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.gz': 'application/gzip',
  '.wasm': 'application/wasm',
};

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let file = path.resolve(root, '.' + urlPath);
  if (!file.startsWith(root + path.sep) && file !== root) {
    res.writeHead(403).end();
    return;
  }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file) || file.includes(`${path.sep}scripts${path.sep}`)) {
    res.writeHead(404).end('Not found');
    return;
  }
  res.writeHead(200, {
    'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
    // Always fresh while developing.
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(file).pipe(res);
});

function lanAddress() {
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (/vethernet|virtual|vmware|vbox|wsl|docker/i.test(name)) continue;
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return 'localhost';
}

server.listen(PORT, '0.0.0.0', async () => {
  const url = `http://${lanAddress()}:${PORT}/`;
  console.log(`\nSmartSnap mobile is running at ${url}`);
  console.log('Scan this with your iPhone camera (same Wi-Fi as this PC):\n');
  console.log(await QRCode.toString(url, { type: 'terminal', small: true }));
  const png = path.join(root, 'scripts', '.qr.png');
  await QRCode.toFile(png, url, { width: 320, margin: 2 });
});
