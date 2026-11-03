'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// Collections and image metadata live in SQLite; image files live on disk
// under <dataDir>/collections/<collectionId>/.
class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.imagesRoot = path.join(dataDir, 'collections');
    fs.mkdirSync(this.imagesRoot, { recursive: true });
    this.db = new Database(path.join(dataDir, 'smartsnap.db'));
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS collections (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        document TEXT,
        document_edited INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS images (
        id INTEGER PRIMARY KEY,
        collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
        position REAL NOT NULL,
        file TEXT NOT NULL,
        edited_file TEXT,
        width INTEGER,
        height INTEGER,
        size INTEGER,
        captured_at INTEGER NOT NULL,
        selected INTEGER NOT NULL DEFAULT 1,
        ocr_status TEXT NOT NULL DEFAULT 'pending',
        ocr_text TEXT,
        ocr_confidence REAL,
        ocr_low_words TEXT,
        ocr_lang TEXT
      );
      CREATE INDEX IF NOT EXISTS images_by_collection ON images(collection_id, position);
    `);
  }

  collectionDir(id) {
    const dir = path.join(this.imagesRoot, String(id));
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  listCollections() {
    return this.db.prepare(`
      SELECT c.id, c.name, c.created_at, c.updated_at,
             COUNT(i.id) AS image_count
      FROM collections c LEFT JOIN images i ON i.collection_id = c.id
      GROUP BY c.id ORDER BY c.updated_at DESC
    `).all();
  }

  getCollection(id) {
    return this.db.prepare('SELECT * FROM collections WHERE id = ?').get(id);
  }

  createCollection(name) {
    const now = Date.now();
    const info = this.db.prepare(
      'INSERT INTO collections (name, created_at, updated_at) VALUES (?, ?, ?)'
    ).run(name, now, now);
    return this.getCollection(info.lastInsertRowid);
  }

  renameCollection(id, name) {
    this.db.prepare('UPDATE collections SET name = ?, updated_at = ? WHERE id = ?').run(name, Date.now(), id);
  }

  deleteCollection(id) {
    this.db.prepare('DELETE FROM collections WHERE id = ?').run(id);
    fs.rmSync(path.join(this.imagesRoot, String(id)), { recursive: true, force: true });
  }

  touch(collectionId) {
    this.db.prepare('UPDATE collections SET updated_at = ? WHERE id = ?').run(Date.now(), collectionId);
  }

  saveDocument(collectionId, text, edited) {
    this.db.prepare('UPDATE collections SET document = ?, document_edited = ?, updated_at = ? WHERE id = ?')
      .run(text, edited ? 1 : 0, Date.now(), collectionId);
  }

  listImages(collectionId) {
    return this.db.prepare('SELECT * FROM images WHERE collection_id = ? ORDER BY position').all(collectionId);
  }

  getImage(id) {
    return this.db.prepare('SELECT * FROM images WHERE id = ?').get(id);
  }

  addImage(collectionId, { file, size, capturedAt }) {
    const { maxPos } = this.db.prepare(
      'SELECT COALESCE(MAX(position), 0) AS maxPos FROM images WHERE collection_id = ?'
    ).get(collectionId);
    const info = this.db.prepare(`
      INSERT INTO images (collection_id, position, file, size, captured_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(collectionId, maxPos + 1, file, size, capturedAt);
    this.touch(collectionId);
    return this.getImage(info.lastInsertRowid);
  }

  updateImage(id, fields) {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    const sets = keys.map((k) => `${k} = @${k}`).join(', ');
    this.db.prepare(`UPDATE images SET ${sets} WHERE id = @id`).run({ ...fields, id });
  }

  reorderImages(collectionId, orderedIds) {
    const stmt = this.db.prepare('UPDATE images SET position = ? WHERE id = ? AND collection_id = ?');
    this.db.transaction(() => {
      orderedIds.forEach((id, i) => stmt.run(i + 1, id, collectionId));
    })();
    this.touch(collectionId);
  }

  deleteImage(id) {
    const img = this.getImage(id);
    if (!img) return;
    this.db.prepare('DELETE FROM images WHERE id = ?').run(id);
    const dir = this.collectionDir(img.collection_id);
    for (const f of [img.file, img.edited_file]) {
      if (f) fs.rmSync(path.join(dir, f), { force: true });
    }
    this.touch(img.collection_id);
  }

  // Absolute path of the version OCR should read: the edit if there is one.
  imagePath(img, { original = false } = {}) {
    const name = !original && img.edited_file ? img.edited_file : img.file;
    return path.join(this.collectionDir(img.collection_id), name);
  }
}

module.exports = { Store };
