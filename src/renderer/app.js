'use strict';

const api = window.smartsnap;
const $ = (id) => document.getElementById(id);

const state = {
  collections: [],
  collection: null,
  images: [],
  focusedId: null,
  blur: new Map(),          // imageId -> blur score (computed once per image version)
  docEdited: false,
  ocrRunning: false,
};

// ---------- small UI helpers ----------

function toast(text, ms = 2200) {
  const t = $('toast');
  t.textContent = text;
  t.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.add('hidden'), ms);
}

function openModal(id) { $(id).classList.remove('hidden'); }
function closeModal(id) { $(id).classList.add('hidden'); }
document.querySelectorAll('.modal').forEach((m) => {
  m.addEventListener('click', (e) => {
    if (e.target === m || e.target.hasAttribute('data-close')) m.classList.add('hidden');
  });
});

// Electron doesn't support window.prompt, so this is our own.
function ask({ title, text = '', value = null, okLabel = 'OK' }) {
  return new Promise((resolve) => {
    $('askTitle').textContent = title;
    $('askText').textContent = text;
    $('askText').classList.toggle('hidden', !text);
    $('askInput').classList.toggle('hidden', value === null);
    $('askInput').value = value ?? '';
    $('askOk').textContent = okLabel;
    openModal('askModal');
    if (value !== null) setTimeout(() => $('askInput').select(), 0);
    const done = (result) => {
      closeModal('askModal');
      $('askOk').onclick = $('askCancel').onclick = $('askInput').onkeydown = null;
      resolve(result);
    };
    $('askOk').onclick = () => done(value === null ? true : $('askInput').value.trim());
    $('askCancel').onclick = () => done(null);
    $('askInput').onkeydown = (e) => {
      if (e.key === 'Enter') $('askOk').click();
      if (e.key === 'Escape') done(null);
    };
  });
}

function formatSize(bytes) {
  if (!bytes) return '';
  return bytes > 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.round(bytes / 1e3)} KB`;
}

function formatTime(ms) {
  return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// ---------- collections ----------

async function refreshCollections() {
  state.collections = await api.collections.list();
  const ul = $('collections');
  ul.innerHTML = '';
  for (const c of state.collections) {
    const li = document.createElement('li');
    li.className = state.collection?.id === c.id ? 'active' : '';
    li.innerHTML = '<span class="name"></span><span class="count"></span><button class="icon-btn del" title="Delete collection">🗑</button>';
    li.querySelector('.name').textContent = c.name;
    li.querySelector('.count').textContent = c.image_count;
    li.onclick = () => openCollection(c.id);
    li.querySelector('.del').onclick = async (e) => {
      e.stopPropagation();
      const ok = await ask({
        title: `Delete "${c.name}"?`,
        text: 'Its photos and extracted text will be removed from this computer. This can\'t be undone.',
        okLabel: 'Delete',
      });
      if (!ok) return;
      await api.collections.remove(c.id);
      if (state.collection?.id === c.id) showNoCollection();
      refreshCollections();
    };
    ul.appendChild(li);
  }
}

async function newCollection() {
  const name = await ask({ title: 'New collection', value: `Collection ${formatTime(Date.now())}`, okLabel: 'Create' });
  if (!name) return;
  const c = await api.collections.create(name);
  await openCollection(c.id);
}

function showNoCollection() {
  state.collection = null;
  state.images = [];
  $('noCollection').classList.remove('hidden');
  $('galleryWrap').classList.add('hidden');
  $('doc').value = '';
  $('docInfo').textContent = '';
}

async function openCollection(id) {
  const { collection, images } = await api.collections.open(id);
  state.collection = collection;
  state.images = images;
  state.focusedId = null;
  state.docEdited = !!collection.document_edited;
  $('noCollection').classList.add('hidden');
  $('galleryWrap').classList.remove('hidden');
  $('collectionName').textContent = collection.name;
  $('doc').value = collection.document || '';
  $('docInfo').textContent = state.docEdited ? 'Edited by you. Rebuild replaces your edits.' : '';
  renderGallery();
  showImageText(null);
  refreshCollections();
}

$('newCollection').onclick = newCollection;
$('emptyNew').onclick = newCollection;
$('collectionName').ondblclick = async () => {
  const name = await ask({ title: 'Rename collection', value: state.collection.name, okLabel: 'Rename' });
  if (!name) return;
  await api.collections.rename(state.collection.id, name);
  state.collection.name = name;
  $('collectionName').textContent = name;
  refreshCollections();
};

// ---------- gallery ----------

function statusFlag(img) {
  switch (img.ocr_status) {
    case 'done': {
      const low = img.ocr_low_words.length;
      return low ? `<span class="flag warn">${low} unsure</span>` : '<span class="flag ok">Text ✓</span>';
    }
    case 'running': return '<span class="flag">Reading…</span>';
    case 'error': return '<span class="flag err">OCR failed</span>';
    default: return '';
  }
}

function cardHtml(img, index) {
  const blurry = state.blur.get(img.id + img.url) < Imaging.BLUR_THRESHOLD;
  return `
    <div class="thumb">
      <img crossorigin="anonymous" alt="">
      <span class="seq">${index + 1}</span>
      <input type="checkbox" class="sel" title="Include in document" ${img.selected ? 'checked' : ''}>
      <div class="flags">
        ${statusFlag(img)}
        ${blurry ? '<span class="flag warn" title="This photo may be out of focus. Consider retaking it.">Blurry?</span>' : ''}
        ${img.edited_file ? '<span class="flag">Edited</span>' : ''}
      </div>
    </div>
    <div class="card-foot">
      <span class="meta"></span>
      <button class="icon-btn edit" title="Crop & straighten">✂</button>
      <button class="icon-btn del" title="Delete">🗑</button>
    </div>`;
}

function renderGallery() {
  const grid = $('grid');
  grid.innerHTML = '';
  const n = state.images.length;
  const selected = state.images.filter((i) => i.selected).length;
  $('imageCount').textContent = n ? `${n} image${n === 1 ? '' : 's'} · ${selected} selected` : '';
  $('gridEmpty').classList.toggle('hidden', n > 0);
  state.images.forEach((img, i) => grid.appendChild(buildCard(img, i)));
  updateOcrButton();
}

function buildCard(img, index) {
  const card = document.createElement('div');
  card.className = 'card' + (img.selected ? '' : ' deselected') + (img.id === state.focusedId ? ' focused' : '');
  card.dataset.id = img.id;
  card.draggable = true;
  card.innerHTML = cardHtml(img, index);
  const meta = [img.width && `${img.width}×${img.height}`, formatSize(img.size), formatTime(img.captured_at)]
    .filter(Boolean).join(' · ');
  card.querySelector('.meta').textContent = meta;
  card.querySelector('.meta').title = meta;

  const el = card.querySelector('img');
  el.onload = () => {
    if (!img.width) {
      img.width = el.naturalWidth;
      img.height = el.naturalHeight;
      api.images.setInfo(img.id, img.width, img.height);
      card.querySelector('.meta').textContent = [`${img.width}×${img.height}`, formatSize(img.size), formatTime(img.captured_at)].join(' · ');
    }
    const key = img.id + img.url;
    if (!state.blur.has(key)) {
      try {
        state.blur.set(key, Imaging.blurScore(el));
        if (state.blur.get(key) < Imaging.BLUR_THRESHOLD) replaceCard(img);
      } catch { /* canvas unavailable: skip the check */ }
    }
  };
  el.src = img.url;

  card.onclick = () => focusImage(img.id);
  const sel = card.querySelector('.sel');
  sel.onclick = (e) => e.stopPropagation();
  sel.onchange = async () => {
    img.selected = sel.checked ? 1 : 0;
    await api.images.select(img.id, sel.checked);
    card.classList.toggle('deselected', !sel.checked);
    renderCountsOnly();
  };
  card.querySelector('.edit').onclick = (e) => { e.stopPropagation(); openEditor(img); };
  card.querySelector('.del').onclick = async (e) => {
    e.stopPropagation();
    const ok = await ask({ title: 'Delete this image?', text: 'The photo and its text will be removed.', okLabel: 'Delete' });
    if (!ok) return;
    await api.images.remove(img.id);
    state.images = state.images.filter((i) => i.id !== img.id);
    if (state.focusedId === img.id) showImageText(null);
    renderGallery();
    refreshCollections();
  };
  wireDrag(card);
  return card;
}

function replaceCard(img) {
  const old = $('grid').querySelector(`.card[data-id="${img.id}"]`);
  const index = state.images.findIndex((i) => i.id === img.id);
  if (old && index >= 0) old.replaceWith(buildCard(img, index));
}

function renderCountsOnly() {
  const n = state.images.length;
  const selected = state.images.filter((i) => i.selected).length;
  $('imageCount').textContent = `${n} image${n === 1 ? '' : 's'} · ${selected} selected`;
  updateOcrButton();
}

// Drag to reorder: drop before or after the card under the pointer.
let dragId = null;
function wireDrag(card) {
  card.addEventListener('dragstart', (e) => {
    dragId = Number(card.dataset.id);
    card.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });
  card.addEventListener('dragend', () => {
    dragId = null;
    card.classList.remove('dragging');
    document.querySelectorAll('.drop-before,.drop-after').forEach((c) => c.classList.remove('drop-before', 'drop-after'));
  });
  card.addEventListener('dragover', (e) => {
    if (dragId === null || Number(card.dataset.id) === dragId) return;
    e.preventDefault();
    const r = card.getBoundingClientRect();
    const after = e.clientX > r.left + r.width / 2;
    card.classList.toggle('drop-after', after);
    card.classList.toggle('drop-before', !after);
  });
  card.addEventListener('dragleave', () => card.classList.remove('drop-before', 'drop-after'));
  card.addEventListener('drop', async (e) => {
    e.preventDefault();
    const targetId = Number(card.dataset.id);
    const after = card.classList.contains('drop-after');
    card.classList.remove('drop-before', 'drop-after');
    if (dragId === null || targetId === dragId) return;
    const moving = state.images.find((i) => i.id === dragId);
    const rest = state.images.filter((i) => i.id !== dragId);
    const at = rest.findIndex((i) => i.id === targetId) + (after ? 1 : 0);
    rest.splice(at, 0, moving);
    state.images = rest;
    renderGallery();
    await api.images.reorder(state.collection.id, rest.map((i) => i.id));
    autoRebuild();
  });
}

$('addImages').onclick = async () => {
  const n = await api.images.importFiles(state.collection.id);
  if (n) toast(`Added ${n} image${n === 1 ? '' : 's'}`);
};
$('selectAll').onclick = () => setAllSelected(true);
$('selectNone').onclick = () => setAllSelected(false);
async function setAllSelected(on) {
  await api.images.selectAll(state.collection.id, on);
  state.images.forEach((i) => { i.selected = on ? 1 : 0; });
  renderGallery();
}

api.on('image-added', (img) => {
  if (state.collection?.id !== img.collection_id) { refreshCollections(); return; }
  state.images.push(img);
  renderGallery();
  refreshCollections();
  toast('New photo from phone');
});

api.on('image-updated', (img) => {
  const i = state.images.findIndex((x) => x.id === img.id);
  if (i < 0) return;
  state.images[i] = img;
  replaceCard(img);
  if (state.focusedId === img.id) showImageText(img);
});

// ---------- per-image text ----------

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function focusImage(id) {
  state.focusedId = id;
  document.querySelectorAll('.card').forEach((c) => c.classList.toggle('focused', Number(c.dataset.id) === id));
  showImageText(state.images.find((i) => i.id === id));
  switchTab('image');
}

function showImageText(img) {
  $('imageTextEdit').classList.add('hidden');
  $('imageText').classList.remove('hidden');
  $('editText').textContent = 'Edit text';
  if (!img) {
    state.focusedId = null;
    $('imageTitle').textContent = 'Click an image to see its text.';
    $('imageInfo').textContent = '';
    $('imageText').innerHTML = '';
    $('rerunOne').classList.add('hidden');
    $('editText').classList.add('hidden');
    return;
  }
  const pos = state.images.findIndex((i) => i.id === img.id) + 1;
  $('imageTitle').textContent = `Image ${pos}`;
  $('rerunOne').classList.remove('hidden');
  $('editText').classList.toggle('hidden', img.ocr_status !== 'done');
  if (img.ocr_status === 'done') {
    const low = img.ocr_low_words;
    $('imageInfo').textContent = `Confidence ${Math.round(img.ocr_confidence)}%` +
      (low.length ? ` · ${low.length} uncertain word${low.length === 1 ? '' : 's'} highlighted` : '');
    let html = escapeHtml(img.ocr_text || '');
    if (low.length) {
      const re = new RegExp(`(^|[\\s(\\["'])(${low.map((w) => escapeRegex(escapeHtml(w))).join('|')})(?=$|[\\s.,;:!?)\\]"'])`, 'g');
      html = html.replace(re, '$1<mark>$2</mark>');
    }
    $('imageText').innerHTML = html || '<span class="muted">No text found in this image.</span>';
  } else if (img.ocr_status === 'error') {
    $('imageInfo').textContent = 'OCR failed';
    $('imageText').textContent = img.ocr_text || '';
  } else {
    $('imageInfo').textContent = img.ocr_status === 'running' ? 'Reading…' : 'Not processed yet. Click Extract text.';
    $('imageText').innerHTML = '';
  }
}

$('editText').onclick = async () => {
  const img = state.images.find((i) => i.id === state.focusedId);
  if (!img) return;
  const editing = !$('imageTextEdit').classList.contains('hidden');
  if (!editing) {
    $('imageTextEdit').value = img.ocr_text || '';
    $('imageTextEdit').classList.remove('hidden');
    $('imageText').classList.add('hidden');
    $('editText').textContent = 'Save text';
    $('imageTextEdit').focus();
    return;
  }
  img.ocr_text = $('imageTextEdit').value;
  img.ocr_low_words = [];
  await api.images.updateText(img.id, img.ocr_text);
  showImageText(img);
  replaceCard(img);
  autoRebuild();
};

$('rerunOne').onclick = () => {
  if (state.focusedId) runOcr([state.focusedId]);
};

// ---------- OCR ----------

function updateOcrButton() {
  const pending = state.images.filter((i) => i.selected && i.ocr_status !== 'done').length;
  $('runOcr').disabled = state.ocrRunning || !pending;
  $('runOcr').textContent = pending ? `Extract text (${pending})` : 'Extract text';
}

async function runOcr(ids) {
  if (state.ocrRunning) return;
  state.ocrRunning = true;
  updateOcrButton();
  try {
    await api.ocr.run(state.collection.id, { lang: $('lang').value, ids });
    await rebuild({ force: false });
  } catch (err) {
    toast(err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 4000);
  } finally {
    state.ocrRunning = false;
    updateOcrButton();
  }
}
$('runOcr').onclick = () => runOcr(null);

api.on('ocr:status', (s) => {
  const show = s.phase !== 'done';
  $('progress').classList.toggle('hidden', !show);
  if (s.phase === 'starting') {
    $('progressBar').style.width = '0';
    // First use of a language downloads its data (a few MB), then it's cached.
    $('ocrMsg').textContent = `Preparing ${s.lang}…`;
  } else if (s.phase === 'running') {
    $('progressBar').style.width = `${(100 * s.done) / s.total}%`;
    $('ocrMsg').textContent = `${s.done} of ${s.total}`;
  } else {
    $('ocrMsg').textContent = s.total ? `Done · ${s.total} image${s.total === 1 ? '' : 's'}` : '';
  }
});

// ---------- document ----------

async function rebuild({ force }) {
  if (state.docEdited && !force) {
    $('docInfo').textContent = 'Edited by you. New text is waiting: click Rebuild to include it (replaces your edits).';
    return;
  }
  const { text, junctions } = await api.doc.build(state.collection.id, $('removeOverlap').checked);
  state.docEdited = false;
  $('doc').value = text;
  const removed = junctions.reduce((n, j) => n + j.removedLines, 0);
  const used = state.images.filter((i) => i.selected && i.ocr_status === 'done').length;
  $('docInfo').textContent = used
    ? `${used} image${used === 1 ? '' : 's'} · ${text.length.toLocaleString()} characters` +
      ($('removeOverlap').checked ? ` · ${removed} repeated line${removed === 1 ? '' : 's'} removed at ${junctions.length} join${junctions.length === 1 ? '' : 's'}` : '')
    : 'No extracted text yet.';
}

function autoRebuild() {
  if (state.images.some((i) => i.ocr_status === 'done')) rebuild({ force: false });
}

$('rebuild').onclick = async () => {
  if (state.docEdited) {
    const ok = await ask({ title: 'Rebuild document?', text: 'This replaces your edits with freshly merged text from the images.', okLabel: 'Rebuild' });
    if (!ok) return;
  }
  rebuild({ force: true });
};
$('removeOverlap').onchange = () => { if (!state.docEdited) rebuild({ force: true }); };

let saveTimer = null;
$('doc').addEventListener('input', () => {
  state.docEdited = true;
  $('docInfo').textContent = 'Edited by you. Rebuild replaces your edits.';
  clearTimeout(saveTimer);
  const id = state.collection.id;
  saveTimer = setTimeout(() => api.doc.save(id, $('doc').value), 400);
});

$('copyAll').onclick = async () => {
  if (!$('doc').value) return toast('Nothing to copy yet');
  await api.doc.copy($('doc').value);
  toast('Copied to clipboard');
};
$('exportTxt').onclick = async () => {
  if (!$('doc').value) return toast('Nothing to export yet');
  const p = await api.doc.exportTxt($('doc').value, state.collection?.name);
  if (p) toast('Saved');
};

function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $('tab-doc').classList.toggle('hidden', name !== 'doc');
  $('tab-image').classList.toggle('hidden', name !== 'image');
}
document.querySelectorAll('.tab').forEach((t) => { t.onclick = () => switchTab(t.dataset.tab); });

// ---------- phone pairing ----------

let pairing = [];
$('connectPhone').onclick = async () => {
  if (!state.collection) {
    toast('Create or open a collection first. Photos are added to it.');
    return;
  }
  pairing = await api.pairing.info();
  if (!pairing.length) {
    toast('No network connection found. Connect this computer to Wi-Fi.', 4000);
    return;
  }
  const sel = $('addr');
  sel.innerHTML = '';
  pairing.forEach((p, i) => sel.add(new Option(`${p.address} (${p.name})`, i)));
  $('addrPick').classList.toggle('hidden', pairing.length < 2);
  showPair(0);
  openModal('pairModal');
};
$('addr').onchange = () => showPair(Number($('addr').value));
function showPair(i) {
  $('qr').src = pairing[i].qr;
  $('pairUrl').textContent = pairing[i].url;
}

// ---------- editor: crop & straighten ----------

const editor = { img: null, source: null, turns: 0, work: null, corners: null, view: null };

async function openEditor(img) {
  editor.img = img;
  editor.turns = 0;
  editor.source = await Imaging.loadImageCors(img.original_url);
  openModal('editModal');
  $('resetEdit').disabled = !img.edited_file;
  setWork();
}

function setWork() {
  editor.work = Imaging.rotated(editor.source, editor.turns);
  const { width: w, height: h } = editor.work;
  editor.corners = [[0, 0], [w, 0], [w, h], [0, h]];
  layoutEditor();
}

function layoutEditor() {
  const stage = $('editorStage');
  const { width: w, height: h } = editor.work;
  const pad = 16;
  const scale = Math.min((stage.clientWidth - pad * 2) / w, (stage.clientHeight - pad * 2) / h);
  const dw = w * scale, dh = h * scale;
  const left = (stage.clientWidth - dw) / 2, top = (stage.clientHeight - dh) / 2;
  editor.view = { scale, left, top };
  const canvas = $('editorCanvas');
  canvas.width = Math.round(dw * devicePixelRatio);
  canvas.height = Math.round(dh * devicePixelRatio);
  Object.assign(canvas.style, { width: `${dw}px`, height: `${dh}px`, left: `${left}px`, top: `${top}px` });
  canvas.getContext('2d').drawImage(editor.work, 0, 0, canvas.width, canvas.height);
  const svg = $('editorOverlay');
  Object.assign(svg.style, { left: '0', top: '0', width: '100%', height: '100%' });
  drawOverlay();
}

function toScreen([x, y]) {
  return [editor.view.left + x * editor.view.scale, editor.view.top + y * editor.view.scale];
}

function drawOverlay() {
  const pts = editor.corners.map(toScreen);
  $('editorOverlay').innerHTML =
    `<polygon class="quad" points="${pts.map((p) => p.join(',')).join(' ')}"></polygon>` +
    pts.map((p, i) => `<circle class="handle" data-i="${i}" cx="${p[0]}" cy="${p[1]}" r="9"></circle>`).join('');
}

$('editorOverlay').addEventListener('pointerdown', (e) => {
  const i = e.target.dataset?.i;
  if (i === undefined) return;
  const svg = $('editorOverlay');
  svg.setPointerCapture(e.pointerId);
  const rect = svg.getBoundingClientRect();
  const { width: w, height: h } = editor.work;
  const move = (ev) => {
    const x = (ev.clientX - rect.left - editor.view.left) / editor.view.scale;
    const y = (ev.clientY - rect.top - editor.view.top) / editor.view.scale;
    editor.corners[i] = [Math.min(Math.max(x, 0), w), Math.min(Math.max(y, 0), h)];
    drawOverlay();
  };
  const up = () => {
    svg.removeEventListener('pointermove', move);
    svg.removeEventListener('pointerup', up);
  };
  svg.addEventListener('pointermove', move);
  svg.addEventListener('pointerup', up);
});

$('rotL').onclick = () => { editor.turns--; setWork(); };
$('rotR').onclick = () => { editor.turns++; setWork(); };
$('cornersFull').onclick = () => setWork();
window.addEventListener('resize', () => { if (!$('editModal').classList.contains('hidden')) layoutEditor(); });

$('applyEdit').onclick = async () => {
  const { width: w, height: h } = editor.work;
  const c = editor.corners;
  const untouched = c[0][0] === 0 && c[0][1] === 0 && c[1][0] === w && c[1][1] === 0 &&
    c[2][0] === w && c[2][1] === h && c[3][0] === 0 && c[3][1] === h;
  if (untouched && editor.turns % 4 === 0) { closeModal('editModal'); return; }
  $('applyEdit').disabled = true;
  try {
    const out = untouched ? editor.work : Imaging.warpQuad(editor.work, c);
    const bytes = await Imaging.canvasToPngBytes(out);
    const updated = await api.images.saveEdit(editor.img.id, bytes);
    afterEdit(updated, 'Saved. Run Extract text to read the edited image.');
    closeModal('editModal');
  } catch (err) {
    toast(err.message, 4000);
  } finally {
    $('applyEdit').disabled = false;
  }
};

$('resetEdit').onclick = async () => {
  const updated = await api.images.resetEdit(editor.img.id);
  afterEdit(updated, 'Original restored. Run Extract text to read it again.');
  closeModal('editModal');
};

function afterEdit(updated, message) {
  const i = state.images.findIndex((x) => x.id === updated.id);
  state.images[i] = updated;
  replaceCard(updated);
  if (state.focusedId === updated.id) showImageText(updated);
  updateOcrButton();
  toast(message);
}

// ---------- start ----------

(async () => {
  await refreshCollections();
  if (state.collections.length) await openCollection(state.collections[0].id);
  else showNoCollection();
})();
