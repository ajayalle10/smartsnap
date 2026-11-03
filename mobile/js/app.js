import * as db from './db.js';
import * as ocr from './ocr.js';
import { decode, resized, toBlob, blurScore, BLUR_THRESHOLD } from './imaging.js';
import { openCropper } from './cropper.js';

const $ = (id) => document.getElementById(id);

const SETTINGS_KEY = 'smartsnap.settings';
const settings = loadSettings();
const STORE_MAX_SIDE = 2400;   // photos are kept at this size; plenty for OCR and re-cropping
const THUMB_MAX_SIDE = 360;

const state = {
  collection: null,
  photos: [],
  thumbs: new Map(),     // photoId -> object URL
  reorder: false,
  viewerIndex: -1,
};

// ---------- small helpers ----------

function loadSettings() {
  const defaults = { cropAfterCapture: true, model: 'fast', maxSide: '1600', workers: '2' };
  try { return { ...defaults, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; } catch { return defaults; }
}
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* private mode */ }
}

function toast(text, ms = 2200) {
  const t = $('toast');
  t.textContent = text;
  t.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.add('hidden'), ms);
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const formatDate = (ms) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// iOS-style action sheet. items: [{label, danger?, run}]
function actionSheet(items) {
  const list = $('actionList');
  list.innerHTML = '';
  const group = document.createElement('div');
  group.className = 'group';
  const close = () => $('actions').classList.add('hidden');
  for (const item of items) {
    const b = document.createElement('button');
    b.textContent = item.label;
    if (item.danger) b.className = 'danger';
    b.onclick = () => { close(); item.run(); };
    group.appendChild(b);
  }
  const cancel = document.createElement('div');
  cancel.className = 'group';
  cancel.innerHTML = '<button class="cancel">Cancel</button>';
  cancel.firstChild.onclick = close;
  list.append(group, cancel);
  $('actions').classList.remove('hidden');
}
$('actions').addEventListener('click', (e) => { if (e.target === $('actions')) $('actions').classList.add('hidden'); });

// Prompt/confirm dialog. With `value` it asks for text.
function dialog({ title, text = '', value = null, ok = 'OK', danger = false }) {
  return new Promise((resolve) => {
    $('dlgTitle').textContent = title;
    $('dlgText').textContent = text;
    $('dlgText').classList.toggle('hidden', !text);
    $('dlgInput').classList.toggle('hidden', value === null);
    $('dlgInput').value = value ?? '';
    $('dlgOk').textContent = ok;
    $('dlgOk').classList.toggle('danger', danger);
    $('dialog').classList.remove('hidden');
    if (value !== null) setTimeout(() => $('dlgInput').focus(), 50);
    const done = (r) => {
      $('dialog').classList.add('hidden');
      $('dlgOk').onclick = $('dlgCancel').onclick = $('dlgInput').onkeydown = null;
      resolve(r);
    };
    $('dlgOk').onclick = () => done(value === null ? true : $('dlgInput').value.trim() || null);
    $('dlgCancel').onclick = () => done(null);
    $('dlgInput').onkeydown = (e) => { if (e.key === 'Enter') $('dlgOk').click(); };
  });
}

function thumbUrl(photo) {
  let url = state.thumbs.get(photo.id);
  if (!url) {
    url = URL.createObjectURL(photo.thumb);
    state.thumbs.set(photo.id, url);
  }
  return url;
}
function dropThumb(id) {
  const url = state.thumbs.get(id);
  if (url) URL.revokeObjectURL(url);
  state.thumbs.delete(id);
}

// ---------- navigation ----------

function show(viewId) {
  for (const id of ['view-home', 'view-collection']) $(id).classList.toggle('hidden', id !== viewId);
  window.scrollTo(0, 0);
}

// Back gesture / button closes the top-most screen.
window.addEventListener('popstate', () => {
  if (!$('viewer').classList.contains('hidden')) return hideViewer();
  if (!$('settings').classList.contains('hidden')) return $('settings').classList.add('hidden');
  if (state.collection) goHome(false);
});

// ---------- home ----------

async function renderHome() {
  const cols = await db.listCollections();
  const ul = $('collections');
  ul.innerHTML = '';
  $('homeEmpty').classList.toggle('hidden', cols.length > 0);
  for (const c of cols) {
    const li = document.createElement('li');
    li.innerHTML = `<div class="thumb"></div><div class="info"><div class="name"></div><div class="meta"></div></div>
      <button class="icon" aria-label="Options"><svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/></svg></button>`;
    li.querySelector('.name').textContent = c.name;
    li.querySelector('.meta').textContent = `${plural(c.photoCount, 'photo')} · ${formatDate(c.updatedAt)}`;
    li.onclick = () => openCollection(c.id);
    li.querySelector('.icon').onclick = (e) => { e.stopPropagation(); collectionMenu(c, true); };
    ul.appendChild(li);
    // First photo as cover, loaded lazily.
    db.listPhotos(c.id).then((ps) => {
      if (ps[0]) li.querySelector('.thumb').style.backgroundImage = `url(${thumbUrl(ps[0])})`;
    });
  }
}

$('newCollection').onclick = async () => {
  const name = await dialog({ title: 'New collection', value: `Collection ${formatDate(Date.now())}`, ok: 'Create' });
  if (!name) return;
  const c = await db.createCollection(name);
  openCollection(c.id);
};

function collectionMenu(c, fromHome) {
  actionSheet([
    { label: 'Rename', run: async () => {
      const name = await dialog({ title: 'Rename collection', value: c.name, ok: 'Rename' });
      if (!name) return;
      await db.updateCollection(c.id, { name });
      if (state.collection?.id === c.id) { state.collection.name = name; $('colName').textContent = name; }
      if (fromHome) renderHome();
    } },
    { label: 'Select all photos', run: () => setAllSelected(true), hidden: fromHome },
    { label: 'Deselect all photos', run: () => setAllSelected(false), hidden: fromHome },
    { label: 'Delete collection', danger: true, run: async () => {
      const ok = await dialog({ title: `Delete "${c.name}"?`, text: 'Its photos and text will be removed from this phone.', ok: 'Delete', danger: true });
      if (!ok) return;
      await db.deleteCollection(c.id);
      if (state.collection?.id === c.id) goHome(true); else renderHome();
    } },
  ].filter((i) => !i.hidden));
}

// ---------- collection ----------

async function openCollection(id, push = true) {
  state.collection = await db.getCollection(id);
  if (!state.collection) return;
  state.photos = await db.listPhotos(id);
  state.reorder = false;
  $('colName').textContent = state.collection.name;
  $('doc').value = state.collection.doc || '';
  switchTab('photos');
  renderGrid();
  renderDocInfo();
  show('view-collection');
  if (push) history.pushState({ collection: id }, '');
}

function goHome(pushBack = true) {
  state.collection = null;
  state.photos = [];
  for (const id of [...state.thumbs.keys()]) dropThumb(id);
  show('view-home');
  renderHome();
  if (pushBack && history.state?.collection) history.back();
}

$('back').onclick = () => goHome(true);
$('colMenu').onclick = () => collectionMenu(state.collection, false);
$('colName').onclick = () => collectionMenu(state.collection, false);

function switchTab(name) {
  document.querySelectorAll('.seg button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $('tab-photos').classList.toggle('hidden', name !== 'photos');
  $('tab-text').classList.toggle('hidden', name !== 'text');
}
document.querySelectorAll('.seg button').forEach((b) => { b.onclick = () => switchTab(b.dataset.tab); });

function chips(p) {
  const out = [];
  if (p.status === 'queued') out.push('<span>Waiting</span>');
  if (p.status === 'reading') out.push('<span>Reading…</span>');
  if (p.status === 'error') out.push('<span class="err">Failed</span>');
  if (p.status === 'done') {
    out.push(p.lowWords?.length && !p.textEdited ? `<span class="warn">${p.lowWords.length} unsure</span>` : '<span class="ok">✓</span>');
  }
  if (p.blur != null && p.blur < BLUR_THRESHOLD) out.push('<span class="warn">Blurry?</span>');
  return out.join('');
}

function renderGrid() {
  const grid = $('grid');
  grid.innerHTML = '';
  state.photos.forEach((p, i) => grid.appendChild(buildCard(p, i)));
  const n = state.photos.length;
  const sel = state.photos.filter((p) => p.selected).length;
  $('photoCount').textContent = n ? `(${n})` : '';
  $('selInfo').textContent = n ? `${sel} of ${n} included` : '';
  $('gridEmpty').classList.toggle('hidden', n > 0);
  $('reorderToggle').classList.toggle('hidden', n < 2);
  $('reorderToggle').textContent = state.reorder ? 'Done' : 'Reorder';
  $('reorderToggle').classList.toggle('primary', state.reorder);
}

function buildCard(p, i) {
  const li = document.createElement('li');
  li.className = 'card' + (p.selected ? '' : ' off');
  li.dataset.id = p.id;
  li.innerHTML = `<img alt=""><span class="num">${i + 1}</span>
    <button class="sel ${p.selected ? 'on' : ''}" aria-label="Include in text"><i></i></button>
    <div class="chip">${chips(p)}</div>`;
  li.querySelector('img').src = thumbUrl(p);
  li.querySelector('.sel').onclick = async (e) => {
    e.stopPropagation();
    p.selected = !p.selected;
    await db.updatePhoto(p.id, { selected: p.selected });
    renderGrid();
    photosChanged();
  };
  if (state.reorder) {
    li.querySelector('.chip').remove();
    const move = document.createElement('div');
    move.className = 'move';
    move.innerHTML = '<button aria-label="Move earlier">‹</button><button aria-label="Move later">›</button>';
    const [earlier, later] = move.querySelectorAll('button');
    earlier.disabled = i === 0;
    later.disabled = i === state.photos.length - 1;
    earlier.onclick = (e) => { e.stopPropagation(); movePhoto(i, -1); };
    later.onclick = (e) => { e.stopPropagation(); movePhoto(i, 1); };
    li.appendChild(move);
  } else {
    li.onclick = () => openViewer(i);
  }
  return li;
}

function updateCard(p) {
  const i = state.photos.findIndex((x) => x.id === p.id);
  if (i < 0) return;
  state.photos[i] = p;
  const old = $('grid').querySelector(`.card[data-id="${p.id}"]`);
  if (old) old.replaceWith(buildCard(p, i));
}

async function movePhoto(i, dir) {
  const j = i + dir;
  [state.photos[i], state.photos[j]] = [state.photos[j], state.photos[i]];
  renderGrid();
  await db.reorderPhotos(state.photos.map((p) => p.id));
  photosChanged();
}

$('reorderToggle').onclick = () => { state.reorder = !state.reorder; renderGrid(); };

async function setAllSelected(on) {
  for (const p of state.photos) {
    p.selected = on;
    await db.updatePhoto(p.id, { selected: on });
  }
  renderGrid();
  photosChanged();
}

// ---------- capture ----------

// Shrinks the photo for storage and makes a thumbnail + blur estimate.
async function storeFields(source) {
  const img = source instanceof Blob ? await decode(source) : source;
  const big = resized(img, STORE_MAX_SIDE);
  const [image, thumb] = await Promise.all([
    toBlob(big, 'image/jpeg', 0.9),
    toBlob(resized(big, THUMB_MAX_SIDE), 'image/jpeg', 0.8),
  ]);
  return { image, thumb, width: big.width, height: big.height, blur: blurScore(big) };
}

async function addPhoto(source) {
  const fields = await storeFields(source);
  const p = await db.addPhoto(state.collection.id, fields);
  state.photos.push(p);
  renderGrid();
  ocr.enqueue(p.id);
  if (p.blur < BLUR_THRESHOLD) toast('This photo looks blurry. You may want to retake it.', 3000);
}

$('camera').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file || !state.collection) return;
  if (!settings.cropAfterCapture) return addPhoto(file);
  const result = await openCropper(file, { mode: 'capture', onRetake: () => $('camera').click() });
  if (result.action === 'use') await addPhoto(result.canvas);
});

$('library').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length || !state.collection) return;
  // Picked together: keep the photos' name order (IMG_0001, IMG_0002…).
  files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  if (files.length === 1 && settings.cropAfterCapture) {
    const result = await openCropper(files[0], { mode: 'capture' });
    if (result.action === 'use') await addPhoto(result.canvas);
    return;
  }
  toast(`Adding ${plural(files.length, 'photo')}…`);
  for (const f of files) await addPhoto(f);
});

// ---------- OCR updates ----------

function onPhotoUpdated(p) {
  if (p.collectionId !== state.collection?.id) return;
  updateCard(p);
  if (state.photos[state.viewerIndex]?.id === p.id) renderViewer();
  if (p.status === 'done' || p.status === 'error') photosChanged();
}

// ---------- photo viewer ----------

let viewerUrl = null;

function openViewer(i) {
  state.viewerIndex = i;
  $('viewer').classList.remove('hidden');
  document.body.classList.add('no-scroll');
  history.pushState({ viewer: true }, '');
  renderViewer();
}

// Closing goes through history so the iPhone back-swipe and the close button
// behave the same; popstate then hides the viewer.
function closeViewer() {
  if (history.state?.viewer) history.back();
  else hideViewer();
}

function hideViewer() {
  $('viewer').classList.add('hidden');
  document.body.classList.remove('no-scroll');
  state.viewerIndex = -1;
  if (viewerUrl) URL.revokeObjectURL(viewerUrl);
  viewerUrl = null;
}

function renderViewer() {
  const p = state.photos[state.viewerIndex];
  if (!p) return closeViewer();
  const n = state.photos.length;
  $('viewerTitle').textContent = `Photo ${state.viewerIndex + 1} of ${n}`;
  $('viewerPrev').disabled = state.viewerIndex === 0;
  $('viewerNext').disabled = state.viewerIndex === n - 1;
  $('viewerSelected').checked = !!p.selected;
  if (viewerUrl) URL.revokeObjectURL(viewerUrl);
  viewerUrl = URL.createObjectURL(p.edited || p.image);
  $('viewerImg').src = viewerUrl;
  $('vCrop').textContent = p.edited ? 'Crop ✓' : 'Crop';
  $('viewerTextEdit').classList.add('hidden');
  $('viewerText').classList.remove('hidden');
  $('vEditText').textContent = 'Edit text';
  $('vEditText').classList.toggle('hidden', p.status !== 'done');

  if (p.status === 'done') {
    const low = p.textEdited ? [] : (p.lowWords || []);
    $('viewerInfo').textContent = p.textEdited ? 'Edited by you'
      : `${Math.round(p.conf)}% confident` + (low.length ? ` · ${plural(low.length, 'unsure word')} highlighted` : '');
    let html = escapeHtml(p.text || '');
    if (low.length) {
      const words = low.map((w) => escapeRegex(escapeHtml(w))).sort((a, b) => b.length - a.length);
      const re = new RegExp(`(^|[\\s(\\[“"'])(${words.join('|')})(?=$|[\\s.,;:!?)\\]”"'])`, 'g');
      html = html.replace(re, '$1<mark>$2</mark>');
    }
    $('viewerText').innerHTML = html || '<span class="muted">No text found in this photo.</span>';
  } else if (p.status === 'error') {
    $('viewerInfo').textContent = 'Reading failed';
    $('viewerText').textContent = p.text;
  } else {
    $('viewerInfo').textContent = p.status === 'reading' ? 'Reading…' : 'Waiting to be read…';
    $('viewerText').innerHTML = '';
  }
}

$('viewerClose').onclick = () => closeViewer();
$('viewerPrev').onclick = () => { state.viewerIndex--; renderViewer(); };
$('viewerNext').onclick = () => { state.viewerIndex++; renderViewer(); };
$('viewerSelected').onchange = async () => {
  const p = state.photos[state.viewerIndex];
  p.selected = $('viewerSelected').checked;
  await db.updatePhoto(p.id, { selected: p.selected });
  renderGrid();
  photosChanged();
};

async function rereadPhoto(p, fields) {
  const updated = await db.updatePhoto(p.id, { ...fields, status: 'queued', text: '', lowWords: [], textEdited: false });
  if (fields.thumb) dropThumb(p.id);
  updateCard(updated);
  renderViewer();
  ocr.enqueue(p.id);
}

$('vCrop').onclick = async () => {
  const p = state.photos[state.viewerIndex];
  // Always crop from the original, so edits don't stack up quality loss.
  const result = await openCropper(p.image, { mode: 'edit', canRestore: !!p.edited });
  if (result.action === 'use') {
    const big = resized(result.canvas, STORE_MAX_SIDE);
    const [edited, thumb] = await Promise.all([toBlob(big, 'image/jpeg', 0.9), toBlob(resized(big, THUMB_MAX_SIDE), 'image/jpeg', 0.8)]);
    await rereadPhoto(p, { edited, thumb, blur: blurScore(big) });
  } else if (result.action === 'restore') {
    const thumb = await toBlob(resized(await decode(p.image), THUMB_MAX_SIDE), 'image/jpeg', 0.8);
    await rereadPhoto(p, { edited: null, thumb });
  }
};

// Retake: the camera must open inside the tap itself.
$('vRetake').onclick = () => $('retakeInput').click();
$('retakeInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  const p = state.photos[state.viewerIndex];
  if (!file || !p) return;
  let source = file;
  if (settings.cropAfterCapture) {
    const result = await openCropper(file, { mode: 'capture', onRetake: () => $('retakeInput').click() });
    if (result.action !== 'use') return;
    source = result.canvas;
  }
  const fields = await storeFields(source);
  await rereadPhoto(p, { ...fields, edited: null });
  toast('Photo replaced');
});

$('vReread').onclick = () => {
  const p = state.photos[state.viewerIndex];
  rereadPhoto(p, {});
};

$('vDelete').onclick = async () => {
  const p = state.photos[state.viewerIndex];
  const ok = await dialog({ title: 'Delete this photo?', text: 'The photo and its text will be removed.', ok: 'Delete', danger: true });
  if (!ok) return;
  ocr.cancel(p.id);
  await db.deletePhoto(p.id);
  dropThumb(p.id);
  state.photos.splice(state.viewerIndex, 1);
  renderGrid();
  photosChanged();
  if (!state.photos.length) return closeViewer();
  state.viewerIndex = Math.min(state.viewerIndex, state.photos.length - 1);
  renderViewer();
};

$('vEditText').onclick = async () => {
  const p = state.photos[state.viewerIndex];
  const editing = !$('viewerTextEdit').classList.contains('hidden');
  if (!editing) {
    $('viewerTextEdit').value = p.text || '';
    $('viewerTextEdit').classList.remove('hidden');
    $('viewerText').classList.add('hidden');
    $('vEditText').textContent = 'Save';
    $('viewerTextEdit').focus();
    return;
  }
  const updated = await db.updatePhoto(p.id, { text: $('viewerTextEdit').value, textEdited: true });
  updateCard(updated);
  renderViewer();
  photosChanged();
};

// ---------- merged document ----------

function mergedText() {
  const parts = state.photos.filter((p) => p.selected && p.status === 'done').map((p) => ({ id: p.id, text: p.text }));
  return { parts, ...Consolidate.consolidate(parts, { removeOverlap: $('removeOverlap').checked }) };
}

// Called whenever photos, their order, selection or text change. Rebuilds
// the document unless the user has edited it by hand.
async function photosChanged() {
  if (!state.collection) return;
  if (state.collection.docEdited) {
    $('docStale').classList.remove('hidden');
    return;
  }
  await rebuildDoc();
}

async function rebuildDoc() {
  const { text } = mergedText();
  $('doc').value = text;
  $('docStale').classList.add('hidden');
  state.collection = await db.updateCollection(state.collection.id, { doc: text, docEdited: false });
  renderDocInfo();
}

function renderDocInfo() {
  const { parts, junctions } = mergedText();
  const removed = junctions.reduce((n, j) => n + j.removedLines, 0);
  const pending = state.photos.filter((p) => p.selected && (p.status === 'queued' || p.status === 'reading')).length;
  const bits = [];
  if (state.collection.docEdited) bits.push('Edited by you');
  else if (parts.length) bits.push(`From ${plural(parts.length, 'photo')}`);
  if (!state.collection.docEdited && removed && $('removeOverlap').checked) bits.push(`${plural(removed, 'repeated line')} removed`);
  if (pending) bits.push(`${pending} still reading…`);
  $('docInfo').textContent = bits.join(' · ');
}

let docSaveTimer = null;
$('doc').addEventListener('input', () => {
  state.collection.docEdited = true;
  clearTimeout(docSaveTimer);
  const id = state.collection.id;
  const text = $('doc').value;
  docSaveTimer = setTimeout(() => db.updateCollection(id, { doc: text, docEdited: true }), 400);
  renderDocInfo();
});

$('docUpdate').onclick = async () => {
  const ok = await dialog({ title: 'Update text?', text: 'This replaces your edits with freshly merged text from the photos.', ok: 'Update' });
  if (ok) rebuildDoc();
};
$('removeOverlap').onchange = () => {
  if (state.collection.docEdited) $('docStale').classList.remove('hidden');
  else rebuildDoc();
};

// ---------- export ----------

$('copyAll').onclick = async () => {
  const text = $('doc').value;
  if (!text) return toast('Nothing to copy yet');
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // No clipboard API on plain-http pages: select and copy instead.
    $('doc').focus();
    $('doc').setSelectionRange(0, text.length);
    document.execCommand('copy');
    $('doc').blur();
  }
  toast('Copied all text');
};

const fileName = (ext) => `${(state.collection?.name || 'SmartSnap').replace(/[\\/:*?"<>|]+/g, '_')}.${ext}`;

$('shareDoc').onclick = async () => {
  const text = $('doc').value;
  if (!text) return toast('Nothing to share yet');
  if (!navigator.share) return toast('Sharing needs the online (https) version. Use Copy all for now.', 3500);
  try {
    const file = new File([text], fileName('txt'), { type: 'text/plain' });
    if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], title: state.collection.name });
    else await navigator.share({ title: state.collection.name, text });
  } catch { /* cancelled */ }
};

$('saveTxt').onclick = () => {
  const text = $('doc').value;
  if (!text) return toast('Nothing to save yet');
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName('txt');
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
};

// PDF through the system print sheet: on iPhone, tap Share in the print
// preview and choose Save to Files.
$('savePdf').onclick = () => {
  const text = $('doc').value;
  if (!text) return toast('Nothing to save yet');
  $('print').innerHTML = `<h1>${escapeHtml(state.collection.name)}</h1>${escapeHtml(text)}`;
  window.print();
};

// ---------- settings ----------

const SETTING_INPUTS = { setModel: 'model', setMaxSide: 'maxSide', setWorkers: 'workers' };

$('openSettings').onclick = async () => {
  $('setCrop').checked = settings.cropAfterCapture;
  for (const [id, key] of Object.entries(SETTING_INPUTS)) $(id).value = settings[key];
  $('settings').classList.remove('hidden');
  history.pushState({ settings: true }, '');
  try {
    const { usage } = await navigator.storage.estimate();
    $('storageInfo').textContent = `Using ${(usage / 1e6).toFixed(1)} MB on this device.`;
  } catch { $('storageInfo').textContent = ''; }
};
document.querySelector('[data-close="settings"]').onclick = () => history.back();
$('setCrop').onchange = () => { settings.cropAfterCapture = $('setCrop').checked; saveSettings(); };
for (const [id, key] of Object.entries(SETTING_INPUTS)) {
  $(id).onchange = () => {
    settings[key] = $(id).value;
    saveSettings();
    ocr.configure(settings);
  };
}

// ---------- start ----------

ocr.onStatus((text, kind) => {
  $('engine').textContent = text;
  $('engine').className = `pill ${kind || ''}`;
});
ocr.configure(settings, onPhotoUpdated).catch((err) => toast(String(err?.message || err), 5000));

(async () => {
  await renderHome();
  db.requestPersistence();
  // Finish photos that were still being read when the app was closed.
  for (const p of await db.unfinishedPhotos()) ocr.enqueue(p.id);
})();

if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
