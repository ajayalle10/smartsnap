// On-phone storage (IndexedDB). Collections hold the merged document;
// photos hold the image blobs, their order and their OCR results.

const DB_NAME = 'smartsnap';
const DB_VERSION = 1;

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('collections', { keyPath: 'id', autoIncrement: true });
      const photos = db.createObjectStore('photos', { keyPath: 'id', autoIncrement: true });
      photos.createIndex('byCollection', 'collectionId');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function wrap(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function store(name, mode = 'readonly') {
  return (await open()).transaction(name, mode).objectStore(name);
}

// ---------- collections ----------

export async function listCollections() {
  const cols = await wrap((await store('collections')).getAll());
  // Count photos with a key cursor so no image blobs get loaded.
  const counts = new Map();
  const db = await open();
  await new Promise((resolve) => {
    const req = db.transaction('photos').objectStore('photos').index('byCollection').openKeyCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return resolve();
      counts.set(c.key, (counts.get(c.key) || 0) + 1);
      c.continue();
    };
  });
  return cols
    .map((c) => ({ ...c, photoCount: counts.get(c.id) || 0 }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getCollection(id) {
  return wrap((await store('collections')).get(id));
}

export async function createCollection(name) {
  const now = Date.now();
  const rec = { name, createdAt: now, updatedAt: now, doc: '', docEdited: false };
  rec.id = await wrap((await store('collections', 'readwrite')).add(rec));
  return rec;
}

export async function updateCollection(id, fields) {
  const s = await store('collections', 'readwrite');
  const rec = await wrap(s.get(id));
  if (!rec) return null;
  Object.assign(rec, fields, { updatedAt: Date.now() });
  await wrap(s.put(rec));
  return rec;
}

export async function deleteCollection(id) {
  const db = await open();
  const tx = db.transaction(['collections', 'photos'], 'readwrite');
  tx.objectStore('collections').delete(id);
  const idx = tx.objectStore('photos').index('byCollection');
  await new Promise((resolve, reject) => {
    const req = idx.openKeyCursor(IDBKeyRange.only(id));
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return resolve();
      tx.objectStore('photos').delete(c.primaryKey);
      c.continue();
    };
    req.onerror = () => reject(req.error);
  });
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
}

// ---------- photos ----------

// iPhone Safari often refuses to store Blobs in IndexedDB ("Error preparing
// Blob/File data to be stored in object store"), so image fields are stored
// as raw bytes and turned back into Blobs when read.
const IMAGE_FIELDS = ['image', 'thumb', 'edited'];

// Must run before opening a transaction: awaiting anything that isn't an
// IndexedDB request inside a transaction makes it close early.
async function packImages(fields) {
  const out = { ...fields };
  for (const key of IMAGE_FIELDS) {
    const v = out[key];
    if (v instanceof Blob) out[key] = { bytes: await v.arrayBuffer(), type: v.type || 'image/jpeg' };
  }
  return out;
}

function unpackImages(rec) {
  if (!rec) return rec;
  for (const key of IMAGE_FIELDS) {
    const v = rec[key];
    // Blobs have a bytes() method too, so check for stored bytes exactly.
    if (v && !(v instanceof Blob) && v.bytes instanceof ArrayBuffer) rec[key] = new Blob([v.bytes], { type: v.type });
  }
  return rec;
}

export async function listPhotos(collectionId) {
  const all = await wrap((await store('photos')).index('byCollection').getAll(collectionId));
  return all.map(unpackImages).sort((a, b) => a.position - b.position);
}

export async function getPhoto(id) {
  return unpackImages(await wrap((await store('photos')).get(id)));
}

export async function addPhoto(collectionId, fields) {
  const existing = await wrap((await store('photos')).index('byCollection').getAll(collectionId));
  const position = existing.reduce((max, p) => Math.max(max, p.position), 0) + 1;
  const rec = {
    collectionId, position, createdAt: Date.now(), selected: true,
    status: 'queued', text: '', conf: null, lowWords: [], edited: null, ...fields,
  };
  const packed = await packImages(rec);
  rec.id = await wrap((await store('photos', 'readwrite')).add(packed));
  await updateCollection(collectionId, {});
  return rec;
}

export async function updatePhoto(id, fields) {
  const packed = await packImages(fields);
  const s = await store('photos', 'readwrite');
  const rec = await wrap(s.get(id));
  if (!rec) return null;
  Object.assign(rec, packed);
  await wrap(s.put(rec));
  return unpackImages(rec);
}

export async function deletePhoto(id) {
  await wrap((await store('photos', 'readwrite')).delete(id));
}

export async function reorderPhotos(orderedIds) {
  const db = await open();
  const tx = db.transaction('photos', 'readwrite');
  const s = tx.objectStore('photos');
  orderedIds.forEach((id, i) => {
    const req = s.get(id);
    req.onsuccess = () => {
      if (req.result) s.put({ ...req.result, position: i + 1 });
    };
  });
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
}

// Photos left mid-OCR when the app was closed.
export async function unfinishedPhotos() {
  const all = await wrap((await store('photos')).getAll());
  return all.filter((p) => p.status === 'queued' || p.status === 'reading').sort((a, b) => a.id - b.id).map(unpackImages);
}

// Ask iOS not to evict our data under storage pressure (granted for
// Home Screen apps).
export async function requestPersistence() {
  try { return await navigator.storage?.persist?.(); } catch { return false; }
}
