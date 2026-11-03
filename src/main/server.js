'use strict';

const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PREFERRED_PORT = 47800;
const MAX_UPLOAD_BYTES = 40 * 1024 * 1024;
const PHONE_PAGE = path.join(__dirname, '..', 'phone', 'index.html');

// LAN IPv4 addresses, private ranges first, so the QR code points somewhere
// the phone can actually reach.
function lanAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const priv = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address);
      const virtual = /vethernet|virtual|vmware|vbox|hyper-v|wsl|docker|loopback/i.test(name);
      out.push({ address: a.address, name, rank: (priv ? 0 : 2) + (virtual ? 1 : 0) });
    }
  }
  return out.sort((x, y) => x.rank - y.rank).map(({ address, name }) => ({ address, name }));
}

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

/**
 * Serves the phone capture page and accepts image uploads.
 * Every request must carry the pairing token from the QR code.
 *
 * @param {{ getTarget: () => {id:number,name:string}|null,
 *           onImage: (collectionId:number, buffer:Buffer, ext:string) => void }} handlers
 */
function startPhoneServer(handlers) {
  const token = crypto.randomBytes(16).toString('hex');

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const provided = Buffer.from(url.searchParams.get('token') || req.headers['x-smartsnap-token'] || '');
    const expected = Buffer.from(token);
    const okToken = provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
    if (!okToken) return send(res, 403, 'Not paired. Scan the QR code shown in SmartSnap.', 'text/plain');

    if (req.method === 'GET' && url.pathname === '/') {
      return send(res, 200, fs.readFileSync(PHONE_PAGE), 'text/html; charset=utf-8');
    }

    if (req.method === 'GET' && url.pathname === '/api/status') {
      const t = handlers.getTarget();
      return send(res, 200, { collection: t ? { id: t.id, name: t.name } : null });
    }

    if (req.method === 'POST' && url.pathname === '/api/upload') {
      const target = handlers.getTarget();
      if (!target) return send(res, 409, { error: 'Open or create a collection in SmartSnap first.' });
      const type = (req.headers['content-type'] || '').split(';')[0];
      const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[type];
      if (!ext) return send(res, 415, { error: `Unsupported image type: ${type || 'unknown'}` });

      const chunks = [];
      let total = 0;
      req.on('data', (c) => {
        total += c.length;
        if (total > MAX_UPLOAD_BYTES) { req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        try {
          const img = handlers.onImage(target.id, Buffer.concat(chunks), ext);
          send(res, 200, { ok: true, id: img.id });
        } catch (err) {
          send(res, 500, { error: err.message });
        }
      });
      return;
    }

    send(res, 404, { error: 'Not found' });
  });

  return new Promise((resolve, reject) => {
    const listen = (port) => {
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE' && port !== 0) listen(0);
        else reject(err);
      });
      server.listen(port, '0.0.0.0', () => {
        resolve({ server, token, port: server.address().port, addresses: lanAddresses() });
      });
    };
    listen(PREFERRED_PORT);
  });
}

module.exports = { startPhoneServer };
