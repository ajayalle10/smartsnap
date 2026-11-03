// Find & replace for the merged-text textarea. All matches are highlighted
// on a layer drawn behind the (transparent) textarea; the current one is
// scrolled into view without focusing, so the iPhone keyboard stays down.

const $ = (id) => document.getElementById(id);

const escapeHtml = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

let matches = [];   // [start, end] offsets into the text
let current = -1;

const doc = () => $('doc');
const isOpen = () => !$('findBar').classList.contains('hidden');

function pattern() {
  const q = $('findInput').value;
  if (!q) return null;
  return new RegExp(escapeRegex(q), $('findCase').checked ? 'g' : 'gi');
}

function search(keepIndex = false) {
  const re = pattern();
  const text = doc().value;
  matches = [];
  if (re) for (const m of text.matchAll(re)) matches.push([m.index, m.index + m[0].length]);
  if (!matches.length) current = -1;
  else if (!keepIndex || current < 0) current = 0;
  else current = Math.min(current, matches.length - 1);
  render();
}

function render() {
  const text = doc().value;
  const bd = $('docBackdrop');
  if (!isOpen() || !matches.length) {
    bd.innerHTML = '';
  } else {
    let html = '';
    let pos = 0;
    matches.forEach(([s, e], i) => {
      html += escapeHtml(text.slice(pos, s)) + `<mark${i === current ? ' class="current"' : ''}>${escapeHtml(text.slice(s, e))}</mark>`;
      pos = e;
    });
    // A trailing newline needs a character after it to take up a line.
    bd.innerHTML = html + escapeHtml(text.slice(pos)) + '\n ';
  }
  $('findCount').textContent = $('findInput').value
    ? (matches.length ? `${current + 1} of ${matches.length}` : 'None')
    : '';
  for (const id of ['findPrev', 'findNext', 'replaceOne', 'replaceAll']) $(id).disabled = !matches.length;
  syncLayer();
}

// Keep the highlight layer the textarea's exact inner size and scroll.
function syncLayer() {
  const ta = doc();
  const bd = $('docBackdrop');
  const scrollbar = ta.offsetWidth - ta.clientWidth - 2;   // 2 = borders
  bd.style.right = `${Math.max(0, scrollbar)}px`;
  bd.scrollTop = ta.scrollTop;
}

function reveal() {
  const mark = $('docBackdrop').querySelector('mark.current');
  if (!mark) return;
  const ta = doc();
  ta.scrollTop = Math.max(0, mark.offsetTop - ta.clientHeight / 3);
  syncLayer();
  // Bring the text box itself into view on a small screen.
  const r = ta.getBoundingClientRect();
  if (r.top < 0 || r.bottom > window.innerHeight) ta.scrollIntoView({ block: 'nearest' });
}

function step(dir) {
  if (!matches.length) return;
  current = (current + dir + matches.length) % matches.length;
  render();
  reveal();
}

// Writes new text into the textarea as if typed, so the app saves it and
// marks the document as edited.
function commit(text) {
  const ta = doc();
  const top = ta.scrollTop;
  ta.value = text;
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  ta.scrollTop = top;
}

export function initFind({ toast }) {
  $('findToggle').onclick = () => {
    const open = !isOpen();
    $('findBar').classList.toggle('hidden', !open);
    $('findToggle').classList.toggle('primary', open);
    if (open) { $('findInput').focus(); search(); } else { matches = []; render(); }
  };
  $('findInput').addEventListener('input', () => { search(); reveal(); });
  $('findInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
  });
  $('findCase').onchange = () => { search(); reveal(); };
  $('findNext').onclick = () => step(1);
  $('findPrev').onclick = () => step(-1);

  $('replaceOne').onclick = () => {
    if (current < 0) return;
    const [s, e] = matches[current];
    const text = doc().value;
    commit(text.slice(0, s) + $('replaceInput').value + text.slice(e));
    search(true);
    reveal();
  };
  $('replaceAll').onclick = () => {
    const re = pattern();
    if (!re || !matches.length) return;
    const n = matches.length;
    const replacement = $('replaceInput').value;
    commit(doc().value.replace(re, () => replacement));
    search();
    toast(`Replaced ${n} match${n === 1 ? '' : 'es'}`);
  };

  doc().addEventListener('scroll', syncLayer);
  doc().addEventListener('input', () => { if (isOpen()) search(true); });
  if (window.ResizeObserver) new ResizeObserver(syncLayer).observe(doc());
}

// Call when the text is replaced from outside (rebuild, collection switch).
export function refreshFind() {
  if (isOpen()) search(true);
}

export function closeFind() {
  $('findBar').classList.add('hidden');
  $('findToggle').classList.remove('primary');
  matches = [];
  render();
}
