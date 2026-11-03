'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { app, BrowserWindow, ipcMain, dialog, clipboard, protocol, net, shell } = require('electron');
const QRCode = require('qrcode');

const { Store } = require('./db');
const { startPhoneServer } = require('./server');
const { OcrEngine } = require('./ocr');
const { consolidate } = require('../shared/consolidate');

protocol.registerSchemesAsPrivileged([
  { scheme: 'snap', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

let win = null;
let store = null;
let ocr = null;
let phone = null;
let activeCollectionId = null;
let ocrRunning = false;

function sendToUi(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// Rows sent to the UI get a URL it can load through the snap:// protocol.
// `v` busts the image cache after an edit.
function withUrls(img) {
  const name = img.edited_file || img.file;
  return {
    ...img,
    ocr_low_words: img.ocr_low_words ? JSON.parse(img.ocr_low_words) : [],
    url: `snap://img/${img.collection_id}/${encodeURIComponent(name)}?v=${encodeURIComponent(name)}`,
    original_url: `snap://img/${img.collection_id}/${encodeURIComponent(img.file)}`,
  };
}

function newFileName(ext) {
  return `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
}

function addImageFromBuffer(collectionId, buffer, ext) {
  const file = newFileName(ext);
  fs.writeFileSync(path.join(store.collectionDir(collectionId), file), buffer);
  const img = store.addImage(collectionId, { file, size: buffer.length, capturedAt: Date.now() });
  sendToUi('image-added', withUrls(img));
  return img;
}

function registerSnapProtocol() {
  protocol.handle('snap', async (request) => {
    const url = new URL(request.url);
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const full = path.resolve(store.imagesRoot, rel);
    if (!full.startsWith(path.resolve(store.imagesRoot) + path.sep)) {
      return new Response('Forbidden', { status: 403 });
    }
    // The UI is a file:// page, so it needs CORS to read these pixels into a
    // canvas (editor and blur check) without tainting it.
    const res = await net.fetch(pathToFileURL(full).toString());
    const headers = new Headers(res.headers);
    headers.set('Access-Control-Allow-Origin', '*');
    return new Response(res.body, { status: res.status, headers });
  });
}

function buildDocument(collectionId, removeOverlap) {
  const parts = store.listImages(collectionId)
    .filter((i) => i.selected && i.ocr_status === 'done')
    .map((i) => ({ id: i.id, text: i.ocr_text || '' }));
  const result = consolidate(parts, { removeOverlap });
  store.saveDocument(collectionId, result.text, false);
  return result;
}

function registerIpc() {
  ipcMain.handle('collections:list', () => store.listCollections());
  ipcMain.handle('collections:create', (_e, name) => store.createCollection(name));
  ipcMain.handle('collections:rename', (_e, id, name) => store.renameCollection(id, name));
  ipcMain.handle('collections:delete', (_e, id) => {
    if (activeCollectionId === id) activeCollectionId = null;
    store.deleteCollection(id);
  });
  ipcMain.handle('collections:open', (_e, id) => {
    activeCollectionId = id;
    store.touch(id);
    return { collection: store.getCollection(id), images: store.listImages(id).map(withUrls) };
  });

  ipcMain.handle('images:select', (_e, id, selected) => store.updateImage(id, { selected: selected ? 1 : 0 }));
  ipcMain.handle('images:selectAll', (_e, collectionId, selected) => {
    for (const img of store.listImages(collectionId)) store.updateImage(img.id, { selected: selected ? 1 : 0 });
  });
  ipcMain.handle('images:reorder', (_e, collectionId, ids) => store.reorderImages(collectionId, ids));
  ipcMain.handle('images:delete', (_e, id) => store.deleteImage(id));
  ipcMain.handle('images:setInfo', (_e, id, width, height) => store.updateImage(id, { width, height }));
  ipcMain.handle('images:updateText', (_e, id, text) => store.updateImage(id, { ocr_text: text }));

  ipcMain.handle('images:saveEdit', (_e, id, pngBytes) => {
    const img = store.getImage(id);
    const dir = store.collectionDir(img.collection_id);
    if (img.edited_file) fs.rmSync(path.join(dir, img.edited_file), { force: true });
    const file = newFileName('png');
    fs.writeFileSync(path.join(dir, file), Buffer.from(pngBytes));
    // An edit changes what OCR sees, so the old text no longer applies.
    store.updateImage(id, {
      edited_file: file, width: null, height: null, ocr_status: 'pending', ocr_text: null, ocr_low_words: null,
    });
    return withUrls(store.getImage(id));
  });
  ipcMain.handle('images:resetEdit', (_e, id) => {
    const img = store.getImage(id);
    if (img.edited_file) fs.rmSync(path.join(store.collectionDir(img.collection_id), img.edited_file), { force: true });
    store.updateImage(id, {
      edited_file: null, width: null, height: null, ocr_status: 'pending', ocr_text: null, ocr_low_words: null,
    });
    return withUrls(store.getImage(id));
  });

  ipcMain.handle('images:import', async (_e, collectionId) => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Add images',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp'] }],
    });
    if (canceled) return 0;
    // Sort by name so numbered files (IMG_001, IMG_002…) keep their order.
    filePaths.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    for (const p of filePaths) {
      const ext = path.extname(p).slice(1).toLowerCase().replace('jpeg', 'jpg');
      addImageFromBuffer(collectionId, fs.readFileSync(p), ext);
    }
    return filePaths.length;
  });

  ipcMain.handle('pairing:info', async () => {
    const urls = phone.addresses.map((a) => ({
      ...a,
      url: `http://${a.address}:${phone.port}/?token=${phone.token}`,
    }));
    const qrs = await Promise.all(urls.map((u) => QRCode.toDataURL(u.url, { margin: 1, width: 240 })));
    return urls.map((u, i) => ({ ...u, qr: qrs[i] }));
  });

  // OCR every selected image that has no text yet (or the given ids).
  ipcMain.handle('ocr:run', async (_e, collectionId, { lang, ids }) => {
    if (ocrRunning) throw new Error('OCR is already running.');
    ocrRunning = true;
    try {
      const todo = store.listImages(collectionId).filter((i) =>
        ids ? ids.includes(i.id) : i.selected && i.ocr_status !== 'done');
      sendToUi('ocr:status', { phase: 'starting', total: todo.length, lang });
      await ocr.ensure(lang);
      let done = 0;
      await Promise.all(todo.map(async (img) => {
        store.updateImage(img.id, { ocr_status: 'running' });
        sendToUi('image-updated', withUrls(store.getImage(img.id)));
        try {
          const r = await ocr.recognize(store.imagePath(img), lang);
          store.updateImage(img.id, {
            ocr_status: 'done', ocr_text: r.text, ocr_confidence: r.confidence,
            ocr_low_words: JSON.stringify(r.lowWords), ocr_lang: lang,
          });
        } catch (err) {
          store.updateImage(img.id, { ocr_status: 'error', ocr_text: String(err.message || err) });
        }
        done++;
        sendToUi('image-updated', withUrls(store.getImage(img.id)));
        sendToUi('ocr:status', { phase: 'running', done, total: todo.length });
      }));
      sendToUi('ocr:status', { phase: 'done', total: todo.length });
      return todo.length;
    } finally {
      ocrRunning = false;
    }
  });

  ipcMain.handle('doc:build', (_e, collectionId, removeOverlap) => buildDocument(collectionId, removeOverlap));
  ipcMain.handle('doc:save', (_e, collectionId, text) => store.saveDocument(collectionId, text, true));
  ipcMain.handle('doc:copy', (_e, text) => clipboard.writeText(text));
  ipcMain.handle('doc:exportTxt', async (_e, text, name) => {
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Export as text',
      defaultPath: `${(name || 'SmartSnap').replace(/[\\/:*?"<>|]/g, '_')}.txt`,
      filters: [{ name: 'Text', extensions: ['txt'] }],
    });
    if (canceled) return null;
    fs.writeFileSync(filePath, text, 'utf8');
    return filePath;
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: 'SmartSnap',
    backgroundColor: '#f6f7f9',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.removeMenu();
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  if (process.env.SMARTSNAP_DEVTOOLS) win.webContents.openDevTools({ mode: 'detach' });
}

app.whenReady().then(async () => {
  const dataDir = process.env.SMARTSNAP_DATA_DIR || app.getPath('userData');
  store = new Store(dataDir);
  ocr = new OcrEngine(path.join(dataDir, 'tessdata'));
  registerSnapProtocol();
  phone = await startPhoneServer({
    getTarget: () => (activeCollectionId ? store.getCollection(activeCollectionId) : null),
    onImage: addImageFromBuffer,
  });
  registerIpc();
  createWindow();
});

app.on('window-all-closed', async () => {
  await ocr?.dispose();
  phone?.server.close();
  app.quit();
});
