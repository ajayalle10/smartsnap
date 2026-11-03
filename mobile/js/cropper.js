// Full-screen crop & straighten. Four draggable corners; whatever they
// enclose is flattened to a rectangle. Used straight after taking a photo
// ("capture" mode) and for editing a saved photo ("edit" mode).

import { decode, rotated, warpQuad, isFullQuad } from './imaging.js';

const $ = (id) => document.getElementById(id);
const PAD = 28;   // keeps the corner handles inside the screen and easy to grab

const st = { work: null, source: null, turns: 0, corners: null, view: null, done: null };

/**
 * @param {Blob} blob
 * @param {{mode:'capture'|'edit', canRestore?:boolean, onRetake?:() => void}} opts
 * @returns {Promise<{action:'use', canvas:HTMLCanvasElement}|{action:'restore'}|{action:'cancel'}|{action:'retake'}>}
 */
export async function openCropper(blob, opts) {
  st.source = await decode(blob);
  st.turns = 0;
  const capture = opts.mode === 'capture';
  $('cropTitle').textContent = capture ? 'Crop photo' : 'Crop & straighten';
  $('cropRetake').classList.toggle('hidden', !capture);
  $('cropCancel').classList.toggle('hidden', capture);
  $('cropRestore').classList.toggle('hidden', capture || !opts.canRestore);
  $('cropFull').textContent = capture ? 'Use full photo' : 'Reset corners';
  $('cropApply').textContent = capture ? 'Crop & use' : 'Apply';
  $('cropper').classList.remove('hidden');
  document.body.classList.add('no-scroll');
  setWork();

  return new Promise((resolve) => {
    const finish = (result) => {
      $('cropper').classList.add('hidden');
      document.body.classList.remove('no-scroll');
      $('cropRetake').onclick = $('cropCancel').onclick = $('cropRestore').onclick =
        $('cropFull').onclick = $('cropApply').onclick = null;
      resolve(result);
    };
    // Retake must open the camera inside the tap handler itself, or iOS
    // won't allow it.
    $('cropRetake').onclick = () => { opts.onRetake?.(); finish({ action: 'retake' }); };
    $('cropCancel').onclick = () => finish({ action: 'cancel' });
    $('cropRestore').onclick = () => finish({ action: 'restore' });
    $('cropFull').onclick = () => {
      if (capture) finish({ action: 'use', canvas: st.work });
      else resetCorners();
    };
    $('cropApply').onclick = async () => {
      const { width: w, height: h } = st.work;
      if (isFullQuad(st.corners, w, h)) {
        if (!capture && st.turns % 4 === 0) return finish({ action: 'cancel' });
        return finish({ action: 'use', canvas: st.work });
      }
      $('cropApply').disabled = true;
      $('cropBusy').classList.remove('hidden');
      // Let the "Working…" label paint before the heavy loop.
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
      try {
        finish({ action: 'use', canvas: warpQuad(st.work, st.corners) });
      } catch (err) {
        alert(err.message);
      } finally {
        $('cropApply').disabled = false;
        $('cropBusy').classList.add('hidden');
      }
    };
  });
}

function setWork() {
  st.work = rotated(st.source, st.turns);
  resetCorners();
}

function resetCorners() {
  const { width: w, height: h } = st.work;
  st.corners = [[0, 0], [w, 0], [w, h], [0, h]];
  layout();
}

function layout() {
  if (!st.work) return;
  const stage = $('cropStage');
  const { width: w, height: h } = st.work;
  const sw = stage.clientWidth, sh = stage.clientHeight;
  const scale = Math.min((sw - PAD * 2) / w, (sh - PAD * 2) / h);
  const dw = w * scale, dh = h * scale;
  st.view = { scale, left: (sw - dw) / 2, top: (sh - dh) / 2 };
  const canvas = $('cropCanvas');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(dw * dpr);
  canvas.height = Math.round(dh * dpr);
  Object.assign(canvas.style, { width: `${dw}px`, height: `${dh}px`, left: `${st.view.left}px`, top: `${st.view.top}px` });
  canvas.getContext('2d').drawImage(st.work, 0, 0, canvas.width, canvas.height);
  draw();
}

const toScreen = ([x, y]) => [st.view.left + x * st.view.scale, st.view.top + y * st.view.scale];

function draw() {
  const pts = st.corners.map(toScreen);
  const poly = pts.map((p) => p.join(',')).join(' ');
  const { clientWidth: W, clientHeight: H } = $('cropStage');
  // Dim everything outside the quad (even-odd fill with a hole).
  $('cropOverlay').innerHTML =
    `<path class="shade" fill-rule="evenodd" d="M0 0H${W}V${H}H0Z M${pts.map((p) => p.join(' ')).join(' L')}Z"></path>` +
    `<polygon class="quad" points="${poly}"></polygon>` +
    pts.map((p, i) =>
      `<circle class="hit" data-i="${i}" cx="${p[0]}" cy="${p[1]}" r="26"></circle>` +
      `<circle class="handle" cx="${p[0]}" cy="${p[1]}" r="11"></circle>`).join('');
}

function initDrag() {
  const svg = $('cropOverlay');
  svg.addEventListener('pointerdown', (e) => {
    const i = e.target.dataset?.i;
    if (i === undefined) return;
    e.preventDefault();
    try { svg.setPointerCapture(e.pointerId); } catch { /* still works without capture */ }
    const rect = svg.getBoundingClientRect();
    const { width: w, height: h } = st.work;
    const move = (ev) => {
      const x = (ev.clientX - rect.left - st.view.left) / st.view.scale;
      const y = (ev.clientY - rect.top - st.view.top) / st.view.scale;
      st.corners[i] = [Math.min(Math.max(x, 0), w), Math.min(Math.max(y, 0), h)];
      draw();
    };
    const up = () => {
      svg.removeEventListener('pointermove', move);
      svg.removeEventListener('pointerup', up);
      svg.removeEventListener('pointercancel', up);
    };
    svg.addEventListener('pointermove', move);
    svg.addEventListener('pointerup', up);
    svg.addEventListener('pointercancel', up);
  });
  $('cropRotL').onclick = () => { st.turns--; setWork(); };
  $('cropRotR').onclick = () => { st.turns++; setWork(); };
  window.addEventListener('resize', () => { if (!$('cropper').classList.contains('hidden')) layout(); });
}

initDrag();
