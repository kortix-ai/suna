'use strict';
/* Kortix Capture: timeline, search and settings. No dependencies, no network. */

const $ = (s, root = document) => root.querySelector(s);
const ICONS = {
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
  external: '<path d="M14 4h6v6"/><path d="M20 4 10 14"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  text: '<path d="M4 7V5h16v2"/><path d="M12 5v14"/><path d="M9 19h6"/>',
  textoff: '<path d="M4 7V5h9"/><path d="M12 5v14"/><path d="M9 19h6"/><path d="M4 4l16 16"/>',
  sliders: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  now: '<path d="M6 5l9 7-9 7z"/><path d="M19 5v14"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  left: '<path d="m15 6-6 6 6 6"/>',
  right: '<path d="m9 6 6 6-6 6"/>',
  cal: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18"/>',
  app: '<rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="4" width="7" height="7" rx="1"/><rect x="4" y="13" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1"/>',
  check: '<path d="m5 12 5 5 9-10"/>',
  back: '<path d="M19 12H5"/><path d="m11 6-6 6 6 6"/>',
  play: '<path d="M8 5.5v13l10.5-6.5z"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  sound: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>',
  muted: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="m16 9.5 5 5M21 9.5l-5 5"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  wave: '<path d="M3 12h2M7 8v8M11 5v14M15 8v8M19 10.5v3M21 12h0"/>',
};
const icon = (n) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[n]}</svg>`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const post = (m) => { try { window.ipc.postMessage(JSON.stringify(m)); } catch (_) {} };
const api = async (path, opts) => {
  const r = await fetch(path, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
};
const TZ = () => -new Date().getTimezoneOffset() * 60;

const fmtDate = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
const fmtDay = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const fmtTime = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' });
const fmtHM = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

const S = {
  T: Date.now(),
  spp: 6000, // milliseconds per track pixel
  bounds: { count: 0 },
  frameId: null,
  frame: null,
  hideHl: false,
  terms: [],
  segs: [],
  segRange: [0, 0],
  segsLoaded: false,
  follow: true, // the playhead rides the newest frame until the user moves away
  ready: false, // input is ignored until the first position is set
  readyAt: Infinity,
  present: false, // the user has moved the pointer, pressed, or typed inside this window
  wheel: { carry: false, last: 0, prev: null },
  hoverX: null,
  filters: { app: [], domain: [], from: null, to: null },
  q: '',
  audio: [], // audio segments in the cached window: {id, s, e, url}
  playing: false,
  muted: (() => { try { return localStorage.getItem('kmem.muted') === '1'; } catch (_) { return false; } })(),
};
const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? '\u2318' : 'Ctrl+';
const PC = deviceNoun(navigator.platform);
const frameCache = new Map();

/* ---------- static chrome ---------- */
$('#btn-hl').innerHTML = icon('text');
$('#btn-copy').innerHTML = icon('copy');
$('#btn-open').innerHTML = icon('external');
$('#btn-search').innerHTML = `${icon('search')}<span>Search recordings</span><kbd>/</kbd>`;
$('#nav-prev').innerHTML = icon('left');
$('#nav-next').innerHTML = icon('right');
$('#btn-settings').innerHTML = icon('sliders');
$('#btn-zoom-out').innerHTML = icon('minus');
$('#btn-zoom-in').innerHTML = icon('plus');
$('#btn-now').innerHTML = `${icon('now')}<span>Now</span>`;
$('#btn-play').innerHTML = icon('play');

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.h);
  toast.h = setTimeout(() => (t.hidden = true), 1800);
}

/* ---------- stage: frame viewer ---------- */
const vid = $('#vid'), img = $('#img'), ocr = $('#ocr'), stage = $('#stage'), notice = $('#notice');
let stageDims = { w: 16, h: 10 };

function fitStage() {
  const wrap = $('#stage-wrap');
  const W = wrap.clientWidth, H = wrap.clientHeight;
  const { w, h } = stageDims;
  const s = Math.min(W / w, H / h);
  const dw = Math.max(1, Math.floor(w * s)), dh = Math.max(1, Math.floor(h * s));
  stage.style.width = dw + 'px';
  stage.style.height = dh + 'px';
  stage.style.marginLeft = -dw / 2 + 'px';
  stage.style.marginTop = -dh / 2 + 'px';
  layoutOcr();
}

function showNotice(title, body, over) {
  notice.className = 'notice' + (over ? ' over' : '');
  notice.innerHTML = title == null ? '' : `<h2>${esc(title)}</h2><p>${esc(body)}</p>`;
  notice.hidden = false;
}

function termsOf(q) {
  return (q || '').replace(/"/g, ' ').split(/\s+/).filter((w) => w && !/^(AND|OR|NOT|NEAR)$/.test(w))
    .map((w) => w.replace(/^[-+]/, '').replace(/\*+$/, '').toLowerCase()).filter((w) => w.length > 1);
}
function stems(t) {
  const s = t.replace(/(ing|ed|es|s)$/, '');
  return s.length >= 3 && s !== t ? [t, s] : [t];
}
const isHit = (text) => {
  const l = text.toLowerCase();
  return S.terms.some((t) => stems(t).some((x) => l.includes(x)));
};

function renderOcr(f) {
  ocr.textContent = '';
  if (!f || !f.boxes) return;
  const frag = document.createDocumentFragment();
  for (const b of f.boxes) {
    if (!b.text) continue;
    const d = document.createElement('div');
    d.className = 'box' + (S.terms.length && isHit(b.text) ? ' hit' : '');
    d.textContent = b.text;
    d._b = b;
    frag.appendChild(d);
  }
  ocr.appendChild(frag);
  layoutOcr();
}

/* Size each transparent text box to its OCR rectangle so selection matches the pixels. */
function layoutOcr() {
  const f = S.frame;
  if (!f || !f.w || !f.h) return;
  const dw = stage.clientWidth, dh = stage.clientHeight;
  const sx = dw / f.w, sy = dh / f.h;
  const boxes = ocr.children;
  for (let i = 0; i < boxes.length; i++) {
    const d = boxes[i], b = d._b;
    d.style.transform = '';
    d.style.left = b.x * sx + 'px';
    d.style.top = b.y * sy + 'px';
    d.style.height = b.h * sy + 'px';
    d.style.fontSize = Math.max(4, b.h * sy * 0.82) + 'px';
    d.style.minWidth = b.w * sx + 'px';
  }
  // Second pass (reads after writes): stretch text to the box width.
  for (let i = 0; i < boxes.length; i++) {
    const d = boxes[i], b = d._b;
    const nat = d.scrollWidth;
    const want = b.w * sx;
    if (nat > 0 && want > 0) d.style.transform = `scaleX(${want / nat})`;
    d.style.minWidth = '';
    d.style.width = nat + 'px';
  }
}

let seekToken = 0;
function showMedia(f) {
  const m = f.media;
  notice.hidden = true;
  stageDims = { w: f.w || 1600, h: f.h || 1000 };
  fitStage();
  if (m.kind === 'still') {
    vid.classList.remove('on');
    img.classList.add('on');
    if (img.dataset.src !== m.url) { img.dataset.src = m.url; img.src = m.url; }
  } else if (m.kind === 'video') {
    img.classList.remove('on');
    const token = ++seekToken;
    const at = m.index + 0.5;
    const seek = () => {
      if (token !== seekToken) return;
      const done = () => { if (token === seekToken) vid.classList.add('on'); };
      vid.addEventListener('seeked', done, { once: true });
      if (Math.abs(vid.currentTime - at) < 0.01) done(); else vid.currentTime = at;
    };
    if (vid.dataset.url !== m.url) {
      vid.classList.remove('on');
      vid.dataset.url = m.url;
      vid.addEventListener('loadedmetadata', seek, { once: true });
      vid.src = m.url;
      vid.load();
    } else if (vid.readyState >= 1) seek();
    else vid.addEventListener('loadedmetadata', seek, { once: true });
  } else {
    vid.classList.remove('on');
    img.classList.remove('on');
    ++seekToken;
    if (m.kind === 'removed') showNotice('Screenshot removed', 'It was removed to save storage. Its text is still searchable.', true);
    else showNotice('Screenshot missing', 'The image for this moment is not in the library.', true);
  }
}

async function loadFrame(id) {
  let f = frameCache.get(id);
  if (!f) {
    f = await api('/api/frame/' + id);
    frameCache.set(id, f);
    if (frameCache.size > 300) frameCache.delete(frameCache.keys().next().value);
  }
  return f;
}

function iconHtml(app, name) {
  if (app && app.icon) return `<img src="/media/icon/app/${app.id}" alt="">`;
  return esc((name || '?').trim().charAt(0).toUpperCase());
}

function renderMeta(f) {
  $('#meta-icon').innerHTML = iconHtml(f.app, f.app?.name);
  $('#meta-title').textContent = f.title || f.app?.name || 'Untitled';
  const bits = [f.app?.name, f.url ? f.url.replace(/^https?:\/\//, '') : f.domain?.name].filter(Boolean);
  $('#meta-sub').textContent = bits.join('  ·  ');
  $('#btn-open').disabled = !/^https?:\/\//.test(f.url || '');
  $('#btn-copy').disabled = f.media.kind === 'removed' || f.media.kind === 'missing';
}

async function showFrame(id) {
  const f = await loadFrame(id);
  S.frameId = id;
  S.frame = f;
  renderMeta(f);
  showMedia(f);
  renderOcr(f);
  updateClock();
}

/* ---------- time -> frame sync ---------- */
let syncing = false, syncAgain = false;
async function syncFrame() {
  if (syncing) { syncAgain = true; return; }
  syncing = true;
  try {
    do {
      syncAgain = false;
      if (!S.bounds.count) break;
      const r = await api('/api/nearest?t=' + Math.round(S.T));
      if (r.id != null && r.id !== S.frameId) await showFrame(r.id);
    } while (syncAgain);
  } catch (e) { console.error(e); }
  syncing = false;
}
/* Time moves continuously: the stage shows the frame nearest the playhead and the
   playhead never snaps onto it. Frame loads are serialized by syncFrame, so a fast
   scroll never queues work. */
function setT(t, opts = {}) {
  const b = S.bounds;
  if (b.count) t = clamp(t, b.first_ms, b.last_ms);
  S.T = t;
  S.follow = opts.follow ?? (b.count ? t >= b.last_ms : true);
  drawTrack();
  updateClock();
  syncFrame();
  if (S.playing) syncAudio();
}
async function step(dir, seg) {
  if (!S.bounds.count) return;
  stopMomentum();
  const r = await api(`/api/nearest?t=${Math.round(S.T)}&dir=${dir}${seg ? '&seg=1' : ''}`);
  if (r.id == null) return;
  S.T = r.t;
  drawTrack();
  updateClock();
  await showFrame(r.id);
}
const fmtChipDate = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
function updateClock() {
  const el = $('#clock');
  if (!S.bounds.count) { el.innerHTML = ''; return; }
  const d = new Date(S.T);
  el.innerHTML = `${icon('cal')}<span>${esc(fmtChipDate.format(d))} at ${esc(fmtHM.format(d))}</span><svg class="caret" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>`;
}
async function refreshBounds() {
  try {
    const prev = S.bounds;
    const b = await api('/api/bounds');
    S.bounds = b;
    if (b.last_ms !== prev.last_ms || b.count !== prev.count) invalidateSegments();
    if (b.count && prev.count === 0) showEmpty(false);
    if (S.ready && b.count && S.follow && b.last_ms > (prev.last_ms || 0) && !panelOpen()) setT(b.last_ms, { follow: true });
    if (b.count) drawTrack();
    if (!b.count) showEmpty(true);
  } catch (e) { console.error(e); }
}
function showEmpty(on) {
  $('#meta').style.visibility = on ? 'hidden' : '';
  $('#btn-copy').disabled = $('#btn-open').disabled = $('#btn-now').disabled = on;
  if (on) {
    stage.style.visibility = 'hidden';
    showNotice(null, null);
    notice.innerHTML = '<p>No recordings yet.</p>';
  } else { stage.style.visibility = ''; notice.hidden = true; }
}

/* ---------- track ---------- */
const track = $('#track'), ctx2 = track.getContext('2d');
const iconImgs = new Map();
let trackW = 0, trackH = 0, raf = 0;
const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

function iconImage(url) {
  let im = iconImgs.get(url);
  if (!im) {
    im = new Image();
    im.onload = () => drawTrack();
    im.src = url;
    iconImgs.set(url, im);
  }
  return im;
}
function resizeTrack() {
  const r = $('#track-wrap').getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  trackW = r.width; trackH = r.height;
  track.width = Math.round(trackW * dpr);
  track.height = Math.round(trackH * dpr);
  ctx2.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawTrack();
}
const xOf = (t) => trackW / 2 + (t - S.T) / S.spp;
const tOf = (x) => S.T + (x - trackW / 2) * S.spp;

/* Segment cache. One request in flight at a time: a drag asks for new data on
   every paint, and cancelling the previous request each time left the track
   blank until the drag stopped. The old runs stay on screen until the new ones land. */
const SEG_MARGIN = 2; // fetch this many window-spans on each side
let segBusy = false, segRetry = 0;
function segCovers(range, a, b) {
  const span = b - a;
  return a >= range[0] + span * 0.25 && b <= range[1] - span * 0.25;
}
async function ensureSegments() {
  if (segBusy || !trackW) return;
  const a = tOf(0), b = tOf(trackW);
  if (segCovers(S.segRange, a, b)) return;
  const span = b - a;
  const from = Math.floor(a - span * SEG_MARGIN), to = Math.ceil(b + span * SEG_MARGIN);
  segBusy = true;
  try {
    const [r, a] = await Promise.all([api(`/api/segments?from=${from}&to=${to}`), api(`/api/audio?from=${from}&to=${to}`)]);
    S.segs = r.segments;
    S.audio = a.segments;
    S.segRange = [from, to];
    S.segsLoaded = true;
  } catch (e) {
    console.error(e);
    clearTimeout(segRetry);
    segRetry = setTimeout(drawTrack, 1500);
  }
  segBusy = false;
  drawTrack(); // re-checks coverage: the window may have moved while the request ran
}
/* New frames arrived: the cached runs are stale. Keep drawing them, re-read the window. */
function invalidateSegments() { S.segRange = [0, 0]; }

/* ---- track layout: pure functions, no DOM ---- */
// Vivid pastel hues (degrees) for runs whose stored color is missing or grey. Stable per key.
const VIVID_HUES = [172, 228, 6, 46, 276, 140, 330, 24, 200, 100];
function hashKey(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function rgbToHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  if (d === 0) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = mx === r ? ((g - b) / d + (g < b ? 6 : 0)) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}
function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [r + m, g + m, b + m].map((v) => Math.round(v * 255));
}
const VIVID_S = [0.45, 0.7], VIVID_L = [0.55, 0.68];
/* Every run lands in one vivid pastel band, whatever the stored color. The hue comes from
   the web domain's dominant color for browser frames, else the app's. A missing or
   near-grey color takes a stable hue from VIVID_HUES, chosen by the run key.
   Returns [r, g, b]. */
function runColor(seg, dark) {
  const c = seg.domain?.color ?? seg.app?.color;
  let h, s, l;
  const hsl = c != null ? rgbToHsl([(c >> 16) & 255, (c >> 8) & 255, c & 255]) : null;
  if (hsl && hsl[1] >= 0.12 && hsl[2] > 0.06 && hsl[2] < 0.96) {
    [h, s, l] = hsl;
  } else {
    h = VIVID_HUES[hashKey(String(seg.k || seg.app?.bundle || seg.app?.name || seg.domain?.name || '?')) % VIVID_HUES.length];
    s = 0.6; l = 0.62;
  }
  s = clamp(s, VIVID_S[0], VIVID_S[1]);
  l = clamp(l, VIVID_L[0], VIVID_L[1]);
  if (!dark) l = clamp(l - 0.1, 0.42, 0.6); // light dock: a little deeper so the line stays visible
  return hslToRgb(h, s, l);
}
/* Colors for laid-out runs. Neighbours with different keys never look alike: when the hues
   are within 22 degrees the later run turns by 35 degrees until they differ. */
function runColors(runs, dark) {
  const out = [];
  for (let i = 0; i < runs.length; i++) {
    let col = runColor(runs[i].s, dark);
    const prev = out[i - 1];
    if (prev && (runs[i].s.k ?? runs[i].s.app?.id) !== (runs[i - 1].s.k ?? runs[i - 1].s.app?.id)) {
      let [h, s, l] = rgbToHsl(col);
      const ph = rgbToHsl(prev)[0];
      for (let n = 0; n < 9 && Math.min(Math.abs(h - ph), 360 - Math.abs(h - ph)) < 22; n++) h += 35;
      col = hslToRgb(h, s, l);
    }
    out.push(col);
  }
  return out;
}
/* The same color, brighter (the run under the playhead). */
const brighter = ([r, g, b], by = 0.1) => { const [h, s, l] = rgbToHsl([r, g, b]); return hslToRgb(h, s, Math.min(0.85, l + by)); };
/* Which icon a run shows: the site's favicon for browser runs, else the app icon. */
function runIconUrl(seg) {
  if (seg.domain?.icon) return '/media/icon/domain/' + seg.domain.id;
  if (seg.app?.icon) return '/media/icon/app/' + seg.app.id;
  return null;
}
/* Fold short runs for rendering only (the raw runs still feed the tooltip):
   1. a run shorter than max(20 s, 4 px) between two runs with the same key joins them;
   2. a run shorter than 4 px next to another run joins the longer neighbour,
      so the bar does not turn to static at far zoom.
   Returns new objects; `s` / `e` are ms, `n` counts the raw runs folded in. */
const FOLD_MS = 20000, FOLD_PX = 4, JOIN_GAP_MS = 60000;
function foldRuns(segs, spp, pad) {
  const key = (r) => r.k ?? r.app?.id ?? null;
  const dur = (r) => r.e + pad - r.s;
  const shortMs = Math.max(FOLD_MS, FOLD_PX * spp), tinyMs = FOLD_PX * spp;
  const out = [];
  for (const raw of segs) {
    const r = { s: raw.s, e: raw.e, k: raw.k, app: raw.app, domain: raw.domain, n: 1 };
    const prev = out[out.length - 1], before = out[out.length - 2];
    if (prev && before && dur(prev) < shortMs && key(before) != null && key(before) === key(r)
        && prev.s - before.e <= JOIN_GAP_MS && r.s - prev.e <= JOIN_GAP_MS) {
      before.e = r.e; before.n += prev.n + 1;
      out.pop();
      continue;
    }
    if (prev && key(prev) != null && key(prev) === key(r) && r.s - prev.e <= JOIN_GAP_MS) {
      prev.e = r.e; prev.n++;
      continue;
    }
    out.push(r);
  }
  for (let i = 0; i < out.length; i++) {
    const r = out[i];
    if (dur(r) >= tinyMs) continue;
    const p = out[i - 1], n = out[i + 1];
    const near = (x, y) => x && y && Math.abs(y.s - x.e) <= Math.max(JOIN_GAP_MS, tinyMs);
    const pOk = near(p, r), nOk = near(r, n);
    if (!pOk && !nOk) continue;
    const t = pOk && (!nOk || dur(p) >= dur(n)) ? p : n;
    t.s = Math.min(t.s, r.s); t.e = Math.max(t.e, r.e); t.n += r.n;
    out.splice(i, 1);
    i = Math.max(-1, i - 2);
  }
  return out;
}
/* Pixel rectangles for the runs that intersect [0, W]. Every run is at least minW wide
   and never overlaps the next one. A flush neighbour leaves a `gap` px seam. */
function layoutRuns(segs, xOf, W, pad, minW = 3, gap = 3) {
  const out = [];
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const x0 = xOf(s.s);
    let x1 = Math.max(xOf(s.e + pad), x0 + minW);
    const next = segs[i + 1];
    if (next) x1 = Math.min(x1, Math.max(xOf(next.s), x0 + minW));
    if (x1 < 0 || x0 > W) continue;
    out.push({ s, x: x0, w: x1 - x0 });
  }
  for (let i = 1; i < out.length; i++) {
    const p = out[i - 1], r = out[i];
    const space = r.x - (p.x + p.w);
    if (space < gap) {
      const cut = Math.min(gap - space, p.w / 2, r.w / 2);
      p.w -= cut / 2; r.x += cut / 2; r.w -= cut / 2;
    }
  }
  return out;
}
/* Icon centers for laid-out runs. An icon sits at the start of its run. It sticks to the
   left edge while the run is partly scrolled off, so the run under the playhead keeps its
   icon. An icon is skipped when it would come closer than `space` px to the previous one. */
const ICON_SIZE = 22;
function placeIcons(runs, W, size = ICON_SIZE, space = 8, minRun = 18) {
  const out = [];
  let lastX = -Infinity;
  for (const r of runs) {
    if (r.w < minRun || !runIconUrl(r.s)) continue;
    const half = size / 2;
    const cx = Math.max(r.x + half + 1, half + 2);
    if (cx + half > r.x + r.w || cx + half > W) continue;
    if (cx - lastX < size + space) continue;
    out.push({ run: r, cx });
    lastX = cx;
  }
  return out;
}
/* ---- initial position: pure ----
   No explicit time: the newest frame, and follow it as frames arrive.
   An explicit time (deep link or --at): that time clamped into the library, no follow. */
function initialPosition(bounds, requestedMs) {
  if (!bounds || !bounds.count) return { t: null, follow: true };
  if (requestedMs != null && Number.isFinite(requestedMs)) {
    return { t: clamp(requestedMs, bounds.first_ms, bounds.last_ms), follow: false };
  }
  return { t: bounds.last_ms, follow: true };
}
/* ---- run jump: pure ----
   Target time for Cmd/Ctrl+Left (dir -1) or Right (dir +1) over folded runs sorted by start.
   Inside a run, Left goes to that run's start first, then to the previous run's start. In an
   idle gap, Left goes to the start of the run before the gap. Right goes to the next run's
   start. Returns null when there is nowhere to go. */
function runJumpTarget(runs, T, dir, pad, eps = 1000) {
  let cur = -1;
  for (let i = 0; i < runs.length; i++) if (runs[i].s <= T) cur = i; else break;
  if (dir > 0) return cur + 1 < runs.length ? runs[cur + 1].s : null;
  if (cur < 0) return null;
  const inside = T <= runs[cur].e + pad;
  if (!inside || T > runs[cur].s + eps) return runs[cur].s;
  return cur > 0 ? runs[cur - 1].s : null;
}
/* ---- stray wheel input: pure ----
   A freshly opened window can receive the tail of a gesture that began before it existed:
   trackpad momentum, or a device still scrolling. WebKit gives a page no scroll phase, so the
   guard works from timing and presence. `st` = {carry, last, prev, live}.
   1. Events before the first position is set, and in the first `grace` ms after it, are dropped
      and mark a burst; the burst lasts until a pause of `gap` ms.
   2. A new gesture needs a pause of at least `quiet` ms before it. Until the user has shown up (a
      pointer move or press inside the window, or a key), it must also start at least `late` ms
      after the first position. Momentum never survives that long, a deliberate gesture does.
   `now` is the event's own timestamp, so a stalled main thread cannot stretch a burst's gaps.
   Returns whether to apply the event. */
function acceptWheel(st, now, readyAt, present = false, grace = 1500, gap = 150, late = 4000, quiet = 300) {
  const pause = st.prev == null ? Infinity : now - st.prev;
  st.prev = now;
  if (pause >= gap) st.live = false; // a pause ends an accepted gesture
  if (now < readyAt + grace) { st.carry = true; st.last = now; return false; }
  if (st.carry) {
    if (now - st.last < gap) { st.last = now; return false; }
    st.carry = false;
  }
  // A new gesture needs a real pause before it, and either a sign of the user or enough time since opening.
  if (!st.live && !(pause >= quiet && (present || now >= readyAt + late))) { st.carry = true; st.last = now; return false; }
  st.live = true; // the rest of this gesture is accepted
  return true;
}
/* ---- jump popover days: pure ----
   `days` from /api/days (newest first, `date` = local YYYY-MM-DD). One row per recorded day:
   "Today", "Yesterday", else `fmt(date)`. The target is the day's last frame, never midnight,
   which would land in a gap. `curT` marks the day the playhead is on. */
function fmtRecorded(ms, frames) {
  const m = Math.floor(ms / 60000);
  if (m >= 60) return `${Math.floor(m / 60)} h ${m % 60} m`;
  if (m >= 1) return `${m} m`;
  return frames === 1 ? '1 frame' : `${frames} frames`;
}
function dayRows(days, nowMs, curT, fmt) {
  const key = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const now = new Date(nowMs), today = key(nowMs);
  const yesterday = key(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12).getTime());
  const cur = curT == null ? null : key(curT);
  return (days || []).map((d) => {
    const [y, mo, da] = d.date.split('-').map(Number);
    return {
      date: d.date,
      label: d.date === today ? 'Today' : d.date === yesterday ? 'Yesterday' : fmt(new Date(y, mo - 1, da, 12)),
      sub: fmtRecorded(d.recorded_ms || 0, d.frames),
      target: d.last_ms,
      current: d.date === cur,
    };
  });
}
/* ---- settings: pure ---- */
// What the settings copy calls this machine: "Mac" on macOS, "computer" on Windows and Linux.
function deviceNoun(platform) {
  return /Mac/.test(platform || '') ? 'Mac' : 'computer';
}
function fmtBytes(b) {
  b = Number(b) || 0;
  return b >= 1e9 ? (b / 1e9).toFixed(2) + ' GB' : b >= 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.round(b / 1e3) + ' KB';
}
/* The `storage forget` timerange from two datetime-local values, or null unless from < to. */
function forgetRange(from, to) {
  if (!from || !to) return null;
  const a = new Date(from).getTime(), b = new Date(to).getTime();
  return Number.isNaN(a) || Number.isNaN(b) || a >= b ? null : `${from}|${to}`;
}
/* Nested patch for a dotted settings path: ('sync.s3.prefix', 'x') -> {sync: {s3: {prefix: 'x'}}}. */
function pathPatch(path, value) {
  return path.split('.').reverse().reduce((v, k) => ({ [k]: v }), value);
}
function deepMerge(dst, src) {
  for (const [k, v] of Object.entries(src)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    if (v && typeof v === 'object' && !Array.isArray(v) && dst[k] && typeof dst[k] === 'object' && !Array.isArray(dst[k])) deepMerge(dst[k], v);
    else dst[k] = v;
  }
  return dst;
}
/* ---- sync: pure ----
   Sync has three settings: Kortix (the default), your own S3 bucket, or Off. The server owns the
   words of the status line (`view` in /api/sync); these helpers decide which controls show.
   The Sync section shows where recordings go; changing it is under Advanced, and turning
   sync off or signing out asks first. */
const DESTINATIONS = [['kortix', 'Kortix'], ['s3', 'Your S3 bucket'], ['off', 'Off']];
/* What the Sync section shows: the destination that is on now. Off offers the Kortix sign-in. */
const syncShown = (view) => (!view || view.destination === 'off' ? 'kortix' : view.destination);
/* What the Sync section shows for the destination the person picked.
   `app` is /api/app, `view` is /api/sync `view`, `kortix` is /api/sync status.kortix, `job` the sign-in job.
   kind: managed | off | kortix-wait | kortix-in | kortix-out | s3 */
function syncPanel(app, view, chosen, kortix, job) {
  const a = app || {}, v = view || { destination: 'off' }, k = kortix || {};
  const org = k.account_name || '';
  if (a.managed) return { kind: 'managed', title: org ? `Managed by ${org}` : 'Managed', sub: `Set by ${org || 'policy'}.` };
  if (chosen === 'off') return { kind: 'off', sub: 'Recordings stay on this computer.' };
  if (chosen === 's3') return { kind: 's3' };
  if (job && job.running) return { kind: 'kortix-wait', code: job.progress ? job.progress.user_code : null };
  const who = k.member_email ? `Signed in as ${k.member_email}` : '';
  // Signed in means syncing, or paused with a reason in the status line.
  if (a.signed_in) return { kind: 'kortix-in', title: `Kortix · ${k.account_name || 'your account'}`, sub: who };
  return { kind: 'kortix-out', sub: k.sign_in_required ? '' : 'Not connected.' };
}
/* Path-style URLs (`endpoint/bucket/key`) suit MinIO and most self-hosted S3. Hosted services want the bucket in the host name. */
function guessPathStyle(endpoint) {
  let host = '';
  try { host = new URL(String(endpoint).trim()).hostname.toLowerCase(); } catch (_) { return false; }
  return !/(^|\.)(amazonaws\.com|r2\.cloudflarestorage\.com|backblazeb2\.com|digitaloceanspaces\.com|wasabisys\.com)$/.test(host);
}
/* The first missing field of the S3 form, as one sentence, or null. `saved` says the key id and secret are already stored. */
function s3Check(f, saved) {
  const t = (x) => String(x || '').trim();
  if (!/^https?:\/\/[^/\s]+/i.test(t(f.endpoint))) return 'Enter the endpoint, starting with https://.';
  if (!t(f.bucket)) return 'Enter the bucket name.';
  if (!t(f.access_key_id) && !saved) return 'Enter the access key ID.';
  if (!t(f.secret_access_key) && !saved) return 'Enter the secret access key.';
  return null;
}
/* A message for a person from whatever an action threw: one short sentence, never markup or a status line. */
function plainError(msg) {
  const m = String(msg == null ? '' : msg).trim();
  if (!m || /<[a-z!/]/i.test(m) || /HTTP \d{3}|^\w*(Error|Exception):|JSON|fetch|Load failed|NetworkError|at \S+:\d+/.test(m)) return 'Something went wrong. Try again.';
  const first = m.split(/(?<=[.!?])\s/)[0];
  return first.length > 140 ? first.slice(0, 137).trimEnd() + '...' : first;
}
/* Never record: one list. Entries the organization requires come first, locked, then the
   person's own groups, private browsing and entries. `pp` is the policy's privacy block (only
   while synced to Kortix); `org` is the account name or null.
   Row: {kind: group|private|app|site, id, label, sub, locked, on, key}. */
const GROUP_DESC = { password_managers: 'Password manager apps and websites', messaging: 'Messaging apps and websites', banking: 'Bank and finance apps and websites' };
function neverRows(s, groups, pp, org) {
  pp = pp || {};
  const by = org ? `Required by ${org}` : 'Required by policy';
  const rows = [];
  for (const g of groups) if ((pp.exclusion_groups || []).includes(g.id)) rows.push({ kind: 'group', id: g.id, label: g.name, sub: by, locked: true, on: true });
  if (pp.exclude_private_browsing) rows.push({ kind: 'private', id: 'private', label: 'Private browsing windows', sub: by, locked: true, on: true });
  // An entry both lists hold shows once, locked.
  const orgItems = exclusionItems({}, pp).filter((i) => i.locked);
  for (const i of orgItems) rows.push({ kind: i.kind, id: i.v, label: i.v, sub: by, locked: true });
  const required = new Set(orgItems.map((i) => i.kind + i.v));
  const ownItems = exclusionItems(s, {}).filter((i) => !required.has(i.kind + i.v));
  for (const g of groups) if (!(pp.exclusion_groups || []).includes(g.id)) rows.push({ kind: 'group', id: g.id, label: g.name, sub: GROUP_DESC[g.id] || '', locked: false, on: (s.enabled_exclusion_groups || []).includes(g.id) });
  if (!pp.exclude_private_browsing) rows.push({ kind: 'private', id: 'private', label: 'Private browsing windows', sub: 'Skip private and incognito windows', locked: false, on: !!s.exclude_private_browsing });
  for (const i of ownItems) rows.push({ kind: i.kind, id: i.v, label: i.v, sub: '', locked: false, key: i.key });
  return rows;
}
/* Record only included apps and websites: whether it is on, whether the organization set it
   (locked on), and the rows: the organization's entries locked, then the person's own (removable).
   Row: {kind: app|site, id, sub, locked, key}. */
function onlyIncluded(s, pp, org) {
  pp = pp || {};
  const by = org ? `Required by ${org}` : 'Required by policy';
  const orgSet = !!pp.record_only_included;
  const rows = [];
  const seen = new Set();
  const add = (list, kind, locked, key) => {
    for (const v of list || []) if (v && !seen.has(kind + v)) { seen.add(kind + v); rows.push({ kind, id: v, sub: locked ? by : '', locked, key }); }
  };
  add(pp.included_bundle_ids, 'app', true, null);
  add(pp.included_domains, 'site', true, null);
  add(s.included_bundle_ids, 'app', false, 'included_bundle_ids');
  add(s.included_domains, 'site', false, 'included_domains');
  return { on: orgSet || !!s.record_only_included, locked: orgSet, sub: orgSet ? by : '', rows };
}
/* "Keep recordings on this computer" says its rule in one line: with sync on, 7 days and never
   anything not uploaded yet; with sync off, nothing is uploaded, so only space frees it. */
function keepHint(keep, syncOn, limitGb) {
  if (keep === 'custom') return '';
  if (syncOn) return keep === 'space' ? `The oldest go first when the library reaches ${limitGb} GB or the disk runs low.` : 'Removed here after that time, and only once uploaded.';
  return keep === 'space' ? `Nothing is uploaded. The oldest go first when the library reaches ${limitGb} GB or the disk runs low.` : 'Nothing is uploaded. These are gone for good.';
}
/* The "Forget recent recordings" range starts as the last hour: two datetime-local values. */
function lastHour(nowMs) {
  const f = (ms) => { const d = new Date(ms); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
  return { from: f(nowMs - 3600000), to: f(nowMs) };
}
/* macOS: keyboard and mouse recording needs Accessibility and Input Monitoring besides Screen Recording.
   The service reports what macOS granted (heartbeat.granted); null when it does not know yet or off macOS. */
function inputsMissing(app) {
  const hb = app && app.service && app.service.heartbeat;
  const g = hb && hb.running && Array.isArray(hb.granted) ? hb.granted : null;
  if (!g || !app || !/mac/i.test(app.platform || '')) return null;
  const missing = ['accessibility', 'input_monitoring'].filter((k) => !g.includes(k));
  return missing.length ? missing : null;
}
/* Onboarding: which step shows. `app` is /api/app, `job` the sign-in job (/api/sync jobs.connect),
   `view` /api/sync view. permission (macOS, Screen Recording missing) -> connect -> waiting -> done. */
function onboardingStep(app, job, view, o) {
  o = o || {};
  if (job && job.running) return 'waiting';
  if (o.signedIn && view && view.destination === 'kortix') return 'done';
  if (o.mac && app && (app.state === 'permission_missing' || inputsMissing(app)) && !o.permissionSkipped) return 'permission';
  return 'connect';
}
/* ---- end sync: pure ---- */
/* The status line from /api/app `state` and the pause end (epoch ms or null). */
function statusView(state, pausedUntilMs, fmtTime) {
  switch (state) {
    case 'recording': return { text: 'Recording', tone: 'live' };
    case 'paused': return { text: pausedUntilMs ? `Paused until ${fmtTime(new Date(pausedUntilMs))}` : 'Paused', tone: '' };
    case 'permission_missing': return { text: 'Needs permission', tone: 'err' };
    default: return { text: 'Not recording', tone: '' };
  }
}
/* "Pause" choices: [value, label]; the end time for a choice at `now` (epoch ms). Until tomorrow = 6:00 local. */
const PAUSE_CHOICES = [['15m', '15 minutes'], ['1h', '1 hour'], ['tomorrow', 'Until tomorrow']];
function pauseUntil(choice, now) {
  if (choice === '15m') return now + 15 * 60000;
  if (choice === '1h') return now + 3600000;
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 6, 0, 0, 0).getTime();
}
/* "Keep recordings on this computer": one choice over the storage settings.
   1, 7 or 30 days = retention that deletes; "until space runs low" = the storage cap that deletes the oldest.
   Any other combination (set with the CLI) reads as 'custom'. */
const KEEP_CHOICES = [['1', '1 day'], ['7', '7 days'], ['30', '30 days'], ['space', 'Until space runs low']];
function keepChoice(storage) {
  const st = storage || {};
  if (st.management_mode === 'storage_cap' && st.cap_action === 'delete') return 'space';
  if (st.management_mode === 'retention' && st.retention_action === 'delete' && [1, 7, 30].includes(st.retention_days)) return String(st.retention_days);
  return 'custom';
}
function keepPatch(choice) {
  if (choice === 'space') return { storage: { management_mode: 'storage_cap', cap_action: 'delete' } };
  const days = Number(choice);
  return [1, 7, 30].includes(days) ? { storage: { management_mode: 'retention', retention_days: days, retention_action: 'delete' } } : null;
}
/* One add field for apps and websites. A website has a dot, no spaces, and is not a bundle id
   (reverse-DNS: com.example.App) or an executable name (chrome.exe). Returns {kind: 'site'|'app', value} or null. */
const REVERSE_DNS = new Set(['com', 'org', 'net', 'io', 'app', 'dev', 'ai', 'co', 'edu', 'gov', 'me', 'us', 'de', 'uk', 'fr']);
const FILE_EXT = new Set(['exe', 'bat', 'cmd', 'msi', 'lnk', 'bin', 'sh']);
function classifyExclusion(raw) {
  let v = String(raw || '').trim();
  if (!v || /\s/.test(v)) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v) || v.includes('/')) {
    v = v.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split(/[/?#]/)[0].replace(/^www\./i, '');
    return v.includes('.') ? { kind: 'site', value: v.toLowerCase() } : null;
  }
  const labels = v.split('.');
  const dotted = labels.length > 1 && labels.every((l) => /^[a-z0-9-]+$/i.test(l));
  const bundle = labels.length >= 3 && REVERSE_DNS.has(labels[0].toLowerCase());
  const file = FILE_EXT.has(labels[labels.length - 1].toLowerCase());
  if (dotted && !bundle && !file) return { kind: 'site', value: v.replace(/^www\./i, '').toLowerCase() };
  return { kind: 'app', value: v };
}
/* The exclusion list: the person's apps and websites, then the ones the organization set (locked). */
function exclusionItems(s, policyPrivacy) {
  const p = policyPrivacy || {};
  const own = (list, kind, key) => (list || []).map((v) => ({ v, kind, key, locked: false }));
  const org = (list, kind) => (list || []).filter((v) => v).map((v) => ({ v, kind, key: null, locked: true }));
  const items = [...own(s.excluded_bundle_ids, 'app', 'excluded_bundle_ids'), ...own(s.excluded_domains, 'site', 'excluded_domains'),
    ...org(p.excluded_bundle_ids, 'app'), ...org(p.excluded_domains, 'site')];
  const seen = new Set();
  return items.filter((i) => (seen.has(i.kind + i.v) ? false : seen.add(i.kind + i.v)));
}
/* Audio row status from `status.audio` (the recorder's audio.json). */
const AUDIO_SOURCE_NAMES = { microphone: 'microphone', system: 'system audio', file: 'test file' };
function audioStateText(enabled, audio) {
  if (!enabled) return 'Off';
  if (!audio) return 'Starts with the recorder';
  const on = Object.entries(audio.sources || {}).filter(([, v]) => v.state === 'recording' || v.state === 'silent').map(([k]) => AUDIO_SOURCE_NAMES[k] || k);
  switch (audio.state) {
    case 'recording': return `Recording ${on.join(' + ')}`;
    case 'permission_missing': return 'Needs permission to record';
    case 'paused': case 'locked': return 'Paused with screen recording';
    case 'low_disk': return 'Paused: low disk space';
    case 'sync_backlog': return 'Paused: upload backlog';
    case 'error': return 'Error, retrying';
    default: return 'Starting';
  }
}
/* The policy row: the operator's notice, or null without a policy. */
function policyText(cached) {
  if (!cached || !cached.policy) return null;
  const n = (cached.policy.notice || '').trim();
  return n || 'Managed by policy.';
}

/* One list, apps first: {value, label}. An app is named once, by its bundle id. */
function suggestionList(installed, recorded, domains) {
  const out = [], seen = new Set();
  for (const a of [...(installed || []), ...(recorded || [])]) {
    const v = a && a.bundle;
    if (!v || seen.has(v.toLowerCase())) continue;
    seen.add(v.toLowerCase());
    out.push({ value: v, label: a.name || v });
  }
  for (const d of domains || []) if (d && d.name && !seen.has(d.name)) { seen.add(d.name); out.push({ value: d.name, label: 'Website' }); }
  return out;
}
/* ---- end settings: pure ---- */
/* ---- opening zoom: pure ----
   The default view shows about 12 minutes with the newest frame at the playhead. After a long
   recording gap that view holds almost nothing, and the earlier recordings sit off screen. When
   less than `minFrac` of the part of the view up to the newest frame is recorded, widen the view
   until its left half reaches the end of the previous recording, capped at `capMs` across.
   `segs` are raw runs sorted by start. Returns {spp, widened}. */
function openingSpp(bounds, segs, trackW, pad, o = {}) {
  const { defaultMs = 12 * 60000, minFrac = 0.15, capMs = 6 * 3600000, margin = 1.1, minSpp = 250, maxSpp = 90000 } = o;
  const W = Math.max(400, trackW || 0);
  const lim = (v) => Math.min(maxSpp, Math.max(minSpp, v));
  const spp0 = lim(defaultMs / W);
  if (!bounds || !bounds.count || !segs || !segs.length) return { spp: spp0, widened: false };
  const T = bounds.last_ms, half = (spp0 * W) / 2, left = T - half;
  let recorded = 0, prev = null;
  for (const r of segs) {
    const a = Math.max(r.s, left), b = Math.min(r.e + pad, T);
    if (b > a) recorded += b - a;
    if (r.e + pad <= left) prev = r; // the latest run that ends before the view starts
  }
  if (recorded / half >= minFrac || !prev) return { spp: spp0, widened: false };
  const need = ((T - prev.e) * margin) / (W / 2);
  const spp = lim(Math.min(Math.max(spp0, need), capMs / W));
  return { spp, widened: spp > spp0 };
}
/* ---- idle-gap hint: pure ----
   When the playhead sits in a gap of at least `minGapMs` between two runs, return the gap and
   the text for the hint: the key to jump to the nearer end of recording. Else null. */
function gapHint(segs, T, pad, mod, minGapMs = 5 * 60000) {
  let before = null, after = null;
  for (const r of segs) { if (r.s <= T) before = r; else { after = r; break; } }
  if (before && T <= before.e + pad) return null; // inside a run
  const start = before ? before.e + pad : null, end = after ? after.s : null;
  if (start == null || end == null || end - start < minGapMs) return null;
  return { start, end, text: `No recording here. Press ${mod}\u2190 to jump back.` };
}
/* ---- audio: pure ----
   The audio segment that plays at time T, and the offset into it in seconds. */
function audioAt(segs, T) {
  for (const a of segs || []) if (T >= a.s && T < a.e) return { seg: a, offset: (T - a.s) / 1000 };
  return null;
}
/* Pixel bars for the audio indicator: one per stretch of audio in [0, W]. Segments
   closer than `join` px merge, so a continuous recording reads as one quiet line. */
function audioBars(segs, xOf, W, join = 2) {
  const out = [];
  for (const a of segs || []) {
    const x0 = xOf(a.s), x1 = xOf(a.e);
    if (x1 < 0 || x0 > W) continue;
    const last = out[out.length - 1];
    if (last && x0 - (last.x + last.w) <= join) last.w = Math.max(last.w, x1 - last.x);
    else out.push({ x: x0, w: Math.max(1, x1 - x0) });
  }
  return out;
}
/* ---- inertia: pure math ---- */
const MOMENTUM_TAU = 325; // ms; velocity decays as exp(-t / tau)
const MOMENTUM_STOP = 0.02; // px per ms
/* Release velocity (px/ms) from pointer samples [{t, x}], using only the last `win` ms. */
function velocityFromSamples(samples, win = 100) {
  if (samples.length < 2) return 0;
  const end = samples[samples.length - 1];
  let i = samples.length - 1;
  while (i > 0 && end.t - samples[i - 1].t <= win) i--;
  const a = samples[i];
  const dt = end.t - a.t;
  return dt > 0 ? (end.x - a.x) / dt : 0;
}
/* Advance a decaying velocity by dt ms. Returns the distance moved (exact integral) and the new velocity. */
function momentumStep(v, dt, tau = MOMENTUM_TAU) {
  const k = Math.exp(-dt / tau);
  return { dx: v * tau * (1 - k), v: v * k };
}
// Canvas geometry in px (a drawing surface, not CSS spacing): the line's top edge and thickness. The canvas is 12 spacing steps tall.
const TRACK_Y = 18.5, TRACK_H = 7;
// The audio line sits below the run icons (which reach y = 33).
const AUDIO_Y = 37;
// Third-party icon art is drawn for a white ground, so its tile is white in both themes (color.md, escape hatch 1).
const ICON_TILE = '#ffffff';
// Canvas cannot read the --shadow-* tokens; this is shadow-sm's ink.
const BADGE_SHADOW = 'rgb(0 0 0 / 0.1)';
let foldMemo = { segs: null, spp: 0, pad: 0, runs: [] };
function foldedRuns(pad) {
  if (foldMemo.segs !== S.segs || foldMemo.spp !== S.spp || foldMemo.pad !== pad) {
    foldMemo = { segs: S.segs, spp: S.spp, pad, runs: foldRuns(S.segs, S.spp, pad) };
  }
  return foldMemo.runs;
}
function drawTrack() {
  if (raf) return;
  raf = requestAnimationFrame(() => { raf = 0; paintTrack(); });
}
function paintTrack() {
  const g = ctx2, W = trackW, H = trackH;
  if (!W) return;
  g.clearRect(0, 0, W, H);
  const ink = cssVar('--foreground'), weak = cssVar('--muted-foreground');
  const dark = getComputedStyle(document.documentElement).colorScheme === 'dark'; // tokens.css sets color-scheme per theme
  const cy = TRACK_Y + TRACK_H / 2;
  const pad = Math.max(S.bounds.interval_ms || 2000, 2000);
  // Idle base line: one neutral grey line across the whole window. Idle gaps, time before
  // the first frame and time after the last frame all read as this line.
  g.globalAlpha = 0.3; g.fillStyle = weak;
  roundRect(g, 0, cy - 1, W, 2, 1); g.fill();
  g.globalAlpha = 1;
  // Runs: thin vivid lines. The run under the playhead is brighter and glows in its own hue.
  const runs = layoutRuns(foldedRuns(pad), xOf, W, pad);
  const cols = runColors(runs, dark);
  const mid = W / 2;
  const underIdx = runs.findIndex((r) => mid >= r.x && mid <= r.x + r.w);
  const under = underIdx >= 0 ? runs[underIdx] : null;
  runs.forEach((r, i) => {
    if (i === underIdx) return;
    const [cr, cg, cb] = cols[i];
    g.fillStyle = `rgb(${cr},${cg},${cb})`;
    roundRect(g, r.x, TRACK_Y, r.w, TRACK_H, TRACK_H / 2); g.fill();
  });
  if (under) { // drawn last so it sits above the neighbours
    const [cr, cg, cb] = brighter(cols[underIdx], 0.12);
    g.save();
    if (under.w < 12) { // too short for a glow: lighter fill and a 1 px brighter outline
      g.fillStyle = `rgb(${cr},${cg},${cb})`;
      roundRect(g, under.x, TRACK_Y, under.w, TRACK_H, TRACK_H / 2); g.fill();
      const [or, og, ob] = brighter([cr, cg, cb], 0.12);
      g.strokeStyle = `rgb(${or},${og},${ob})`; g.lineWidth = 1;
      roundRect(g, under.x + 0.5, TRACK_Y + 0.5, Math.max(1, under.w - 1), TRACK_H - 1, (TRACK_H - 1) / 2); g.stroke();
    } else { // a soft rim a few px above and below, never past the run's own ends
      g.beginPath(); g.rect(under.x, TRACK_Y - 5, under.w, TRACK_H + 10); g.clip();
      g.shadowColor = `rgba(${cr},${cg},${cb},0.45)`; g.shadowBlur = 8;
      g.fillStyle = `rgb(${cr},${cg},${cb})`;
      roundRect(g, under.x, TRACK_Y, under.w, TRACK_H, TRACK_H / 2); g.fill();
    }
    g.restore();
  }
  // Audio: a quiet line under the runs wherever sound was recorded.
  g.globalAlpha = 0.55; g.fillStyle = weak;
  for (const b of audioBars(S.audio, xOf, W)) { roundRect(g, b.x, AUDIO_Y, b.w, 2, 1); g.fill(); }
  g.globalAlpha = 1;
  // Icons sit on the line at the start of runs.
  for (const ic of placeIcons(runs, W)) {
    const im = iconImage(runIconUrl(ic.run.s));
    if (!(im.complete && im.naturalWidth)) continue;
    const x = ic.cx - ICON_SIZE / 2, y = cy - ICON_SIZE / 2;
    const [cr, cg, cb] = brighter(cols[runs.indexOf(ic.run)]);
    g.save();
    if (ic.run === under) { g.shadowColor = `rgba(${cr},${cg},${cb},0.6)`; g.shadowBlur = 4; g.shadowOffsetY = 0; }
    else { g.shadowColor = BADGE_SHADOW; g.shadowBlur = 5; g.shadowOffsetY = 1; }
    g.fillStyle = ICON_TILE;
    roundRect(g, x, y, ICON_SIZE, ICON_SIZE, 5.5); g.fill();
    g.restore();
    g.save();
    roundRect(g, x + 2, y + 2, ICON_SIZE - 4, ICON_SIZE - 4, 4); g.clip();
    g.drawImage(im, x + 2, y + 2, ICON_SIZE - 4, ICON_SIZE - 4);
    g.restore();
  }
  // Hover marker.
  if (S.hoverX != null && !drag) {
    g.globalAlpha = 0.5; g.fillStyle = weak;
    g.fillRect(Math.round(S.hoverX) - 0.5, cy - 14, 1, 28);
    g.globalAlpha = 1;
  }
  // Playhead: a translucent rounded handle fixed at the center; the track moves under it.
  g.fillStyle = ink; g.strokeStyle = ink; g.lineWidth = 1;
  g.globalAlpha = 0.14; roundRect(g, mid - 4, cy - 17, 8, 34, 4); g.fill();
  g.globalAlpha = 0.4; roundRect(g, mid - 3.5, cy - 16.5, 7, 33, 3.5); g.stroke();
  g.globalAlpha = 1;
  updateGapHint(W, pad);
  ensureSegments();
}
let hintKey = '';
function updateGapHint(W, pad) {
  const el = $('#gap-hint');
  const h = gapHint(S.segs, S.T, pad, MOD);
  if (!h) { if (hintKey) { el.hidden = true; hintKey = ''; } return; }
  // Place beside the playhead, on the side with more of the gap in view.
  const x0 = Math.max(0, xOf(h.start)), x1 = Math.min(W, xOf(h.end)), mid = W / 2;
  const right = x1 - mid >= mid - x0;
  const key = h.text + (right ? 'R' : 'L');
  if (key !== hintKey) {
    el.textContent = h.text;
    el.hidden = false;
    el.style.left = right ? mid + 20 + 'px' : '';
    el.style.right = right ? '' : W - mid + 20 + 'px';
    hintKey = key;
  }
}
function roundRect(g, x, y, w, h, r) { roundRect4(g, x, y, w, h, r, r, r, r); }
/* Corner radii: top-left, top-right, bottom-right, bottom-left. */
function roundRect4(g, x, y, w, h, tl, tr, br, bl) {
  const m = Math.min(w / 2, h / 2);
  tl = Math.min(tl, m); tr = Math.min(tr, m); br = Math.min(br, m); bl = Math.min(bl, m);
  g.beginPath(); g.moveTo(x + tl, y);
  g.lineTo(x + w - tr, y); g.arcTo(x + w, y, x + w, y + tr, tr);
  g.lineTo(x + w, y + h - br); g.arcTo(x + w, y + h, x + w - br, y + h, br);
  g.lineTo(x + bl, y + h); g.arcTo(x, y + h, x, y + h - bl, bl);
  g.lineTo(x, y + tl); g.arcTo(x, y, x + tl, y, tl);
  g.closePath();
}
const SPP_MIN = 250, SPP_MAX = 90000;
/* Zoom is always around the playhead, so the time at the center never moves. */
function zoom(factor) {
  S.spp = clamp(S.spp * factor, SPP_MIN, SPP_MAX);
  setT(S.T);
}
/* Motion budget (kit motion.md): a pointer-initiated move is "often", so 200 ms ease-out
   (duration-moderate). A keyboard-initiated move never animates. Reduced motion removes the
   movement. Drag and wheel are direct manipulation, not transitions. */
const GLIDE_MS = 200;
const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const easeOut = (k) => 1 - Math.pow(1 - k, 3);
/* Zoom buttons: tween to the target scale in log space; repeated clicks compound. */
let zoomTarget = null, zoomRaf = 0;
function zoomTween(factor) {
  const target = clamp((zoomTarget ?? S.spp) * factor, SPP_MIN, SPP_MAX);
  if (reduceMotion()) { zoom(target / S.spp); return; }
  cancelAnimationFrame(zoomRaf);
  zoomTarget = target;
  const from = S.spp, t0 = performance.now();
  const tick = (now) => {
    const k = Math.min(1, (now - t0) / GLIDE_MS);
    const want = from * Math.pow(target / from, easeOut(k));
    zoom(want / S.spp);
    if (k < 1) zoomRaf = requestAnimationFrame(tick); else zoomTarget = null;
  };
  zoomRaf = requestAnimationFrame(tick);
}
/* Move the playhead to time t. `instant` for keyboard-initiated moves. */
let panRaf = 0;
function panTo(t, instant = false) {
  cancelAnimationFrame(panRaf);
  if (instant || reduceMotion()) { setT(t); return; }
  const from = S.T, t0 = performance.now();
  const tick = (now) => {
    const k = Math.min(1, (now - t0) / GLIDE_MS);
    setT(k < 1 ? from + (t - from) * easeOut(k) : t);
    if (k < 1) panRaf = requestAnimationFrame(tick);
  };
  panRaf = requestAnimationFrame(tick);
}
function segAt(t) {
  const pad = Math.max(S.bounds.interval_ms || 2000, 2000);
  const x = xOf(t);
  return layoutRuns(S.segs, xOf, trackW, pad).find((r) => x >= r.x && x <= r.x + r.w)?.s;
}

/* Drag the track like a film strip. On release the strip keeps moving and decelerates. */
let drag = null, momRaf = 0;
function stopMomentum() { cancelAnimationFrame(momRaf); momRaf = 0; }
function startMomentum(v) { // v in px/ms, positive = strip moving right (time moving back)
  stopMomentum();
  if (reduceMotion()) return;
  let last = performance.now(), vel = v;
  const tick = (now) => {
    const dt = Math.min(now - last, 50);
    last = now;
    const m = momentumStep(vel, dt);
    vel = m.v;
    const before = S.T;
    setT(S.T - m.dx * S.spp);
    if (Math.abs(vel) < MOMENTUM_STOP || S.T === before) { momRaf = 0; return; }
    momRaf = requestAnimationFrame(tick);
  };
  momRaf = requestAnimationFrame(tick);
}
track.addEventListener('pointerdown', (e) => {
  if (!S.ready) return;
  stopMomentum();
  cancelAnimationFrame(panRaf);
  track.setPointerCapture(e.pointerId);
  drag = { x: e.clientX, T: S.T, moved: false, samples: [{ t: performance.now(), x: e.clientX }] };
  track.classList.add('drag');
});
track.addEventListener('pointermove', (e) => {
  const r = track.getBoundingClientRect();
  if (drag) {
    const dx = e.clientX - drag.x;
    if (Math.abs(dx) > 3) drag.moved = true;
    if (drag.moved) {
      drag.samples.push({ t: performance.now(), x: e.clientX });
      if (drag.samples.length > 12) drag.samples.shift();
      setT(drag.T - dx * S.spp);
    }
    $('#tip').hidden = true;
    return;
  }
  const x = e.clientX - r.left, t = tOf(x), s = segAt(t);
  const tip = $('#tip');
  S.hoverX = x;
  drawTrack();
  tip.hidden = false;
  tip.innerHTML = `${esc(s ? (s.domain?.name || s.app?.name || 'Unknown') : 'No capture')}${audioAt(S.audio, t) ? '  ·  audio' : ''}  ·  <span class="mono">${esc(fmtHM.format(new Date(t)))}</span>`;
  tip.style.left = clamp(x, 80, trackW - 80) + 'px';
});
track.addEventListener('pointerleave', () => { $('#tip').hidden = true; S.hoverX = null; drawTrack(); });
track.addEventListener('pointerup', (e) => {
  track.classList.remove('drag');
  if (drag && !drag.moved) {
    const r = track.getBoundingClientRect();
    panTo(tOf(e.clientX - r.left));
  } else if (drag) {
    drag.samples.push({ t: performance.now(), x: e.clientX });
    const idle = performance.now() - drag.samples[drag.samples.length - 2].t;
    const v = idle > 80 ? 0 : velocityFromSamples(drag.samples);
    if (Math.abs(v) > 0.1) startMomentum(v);
  }
  drag = null;
});

/* Trackpad and wheel scroll move time directly. The OS already sends momentum events. */
function onWheel(e) {
  if (panelOpen() || e.target.closest?.('.pop')) return;
  e.preventDefault();
  if (!acceptWheel(S.wheel, e.timeStamp, S.ready ? S.readyAt : Infinity, S.present)) return;
  if (e.ctrlKey) { // trackpad pinch (and ctrl+scroll)
    zoom(Math.exp(e.deltaY * 0.012));
    return;
  }
  stopMomentum();
  cancelAnimationFrame(panRaf);
  const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
  setT(S.T + d * S.spp);
}
const markPresent = (e) => { if (S.ready && performance.now() > S.readyAt && e.isTrusted) S.present = true; };
window.addEventListener('pointerdown', markPresent, true);
window.addEventListener('keydown', markPresent, true);
window.addEventListener('pointermove', (e) => { if (e.movementX || e.movementY) markPresent(e); }, true);
window.addEventListener('wheel', onWheel, { passive: false });

$('#btn-zoom-in').onclick = () => zoomTween(1 / 1.6);
$('#btn-zoom-out').onclick = () => zoomTween(1.6);
$('#btn-now').onclick = () => S.bounds.count && panTo(S.bounds.last_ms);
/* Jump to the start of the previous / next run (app or site), over the runs the track draws.
   Beyond the loaded runs, fall back to the server's segment step. */
function runJump(dir, instant = false) {
  if (!S.bounds.count || !S.ready) return;
  const pad = Math.max(S.bounds.interval_ms || 2000, 2000);
  const t = runJumpTarget(foldedRuns(pad), S.T, dir, pad);
  stopMomentum();
  if (t != null) { panTo(t, instant); return; }
  step(dir, true);
}
$('#nav-prev').onclick = () => runJump(-1);
$('#nav-next').onclick = () => runJump(1);
$('#nav-prev').title = `Previous run (${MOD}Left)`;
$('#nav-next').title = `Next run (${MOD}Right)`;
$('#btn-zoom-in').title = 'Zoom in (+)';
$('#btn-zoom-out').title = 'Zoom out (-)';

/* Jump chip: pick a recorded day in one click, or an exact date and time. */
const fmtDayRow = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const fmtDayRowYear = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
$('#clock').onclick = async () => {
  if (!S.bounds.count) return;
  if (pop && pop.dataset.kind === 'jump') { closePop(); return; }
  closePop();
  const toLocal = (ms) => { const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000); return d.toISOString().slice(0, 16); };
  const p = document.createElement('div');
  p.className = 'pop jump'; p.dataset.kind = 'jump';
  p.innerHTML = `<label for="jump-at">Jump to</label><div class="jump-at"><input id="jump-at" type="datetime-local" min="${toLocal(S.bounds.first_ms)}" max="${toLocal(S.bounds.last_ms)}" value="${toLocal(S.T)}"><button class="btn primary" id="jump-go">Go</button></div>
    <div class="day-list" id="jump-days" role="listbox" aria-label="Recorded days"></div>`;
  place(p, '#clock');
  const pin = () => { p.style.top = ''; p.style.bottom = window.innerHeight - $('#clock').getBoundingClientRect().top + 6 + 'px'; };
  pin();
  pop = p;
  const go = () => {
    const v = $('#jump-at', p).value;
    if (v) { const t = new Date(v).getTime(); if (!Number.isNaN(t)) panTo(t); }
    closePop();
  };
  $('#jump-go', p).onclick = go;
  $('#jump-at', p).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') go();
    if (e.key === 'ArrowDown') { const first = $('.day-row', p); if (first) { e.preventDefault(); first.focus(); } }
  });
  $('#jump-at', p).focus();
  const list = $('#jump-days', p);
  list.addEventListener('keydown', (e) => {
    const rows = [...list.querySelectorAll('.day-row')], i = rows.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = i + (e.key === 'ArrowDown' ? 1 : -1);
      if (next < 0) $('#jump-at', p).focus(); else rows[Math.min(next, rows.length - 1)].focus();
    }
  });
  list.addEventListener('click', (e) => {
    const row = e.target.closest('.day-row');
    if (!row) return;
    S.follow = false;
    panTo(+row.dataset.t, true);
    closePop();
  });
  try {
    const { days } = await api('/api/days');
    if (pop !== p) return;
    const year = new Date().getFullYear();
    const rows = dayRows(days, Date.now(), S.T, (d) => (d.getFullYear() === year ? fmtDayRow : fmtDayRowYear).format(d));
    list.innerHTML = rows.length
      ? rows.map((r) => `<button class="day-row${r.current ? ' cur' : ''}" role="option" data-t="${r.target}"${r.current ? ' aria-current="date" aria-selected="true"' : ''}><span class="name">${esc(r.label)}</span><span class="sub">${esc(r.sub)}</span></button>`).join('')
      : '<div class="pop-empty">No recordings yet.</div>';
    pin();
  } catch (e) { console.error(e); }
};

/* ---------- playback: the playhead moves in real time and audio plays along ---------- */
const aud = $('#aud');
let playRaf = 0, playLast = 0, frameSyncAt = 0;
function paintPlay() {
  const b = $('#btn-play');
  b.innerHTML = icon(S.playing ? 'pause' : 'play');
  b.title = S.playing ? 'Pause (Space)' : 'Play (Space)';
  b.setAttribute('aria-pressed', String(S.playing));
  const m = $('#btn-mute');
  m.innerHTML = icon(S.muted ? 'muted' : 'sound');
  m.title = S.muted ? 'Unmute audio (M)' : 'Mute audio (M)';
  m.setAttribute('aria-pressed', String(S.muted));
  aud.muted = S.muted;
}
/* Keep the audio element on the segment under the playhead, within 0.3 s. */
function syncAudio() {
  const hit = S.playing ? audioAt(S.audio, S.T) : null;
  if (!hit) { if (!aud.paused) aud.pause(); return; }
  if (aud.dataset.id !== String(hit.seg.id)) {
    aud.dataset.id = String(hit.seg.id);
    aud.src = hit.seg.url;
    aud.addEventListener('loadedmetadata', () => { if (aud.dataset.id === String(hit.seg.id)) { aud.currentTime = (S.T - hit.seg.s) / 1000; if (S.playing) aud.play().catch(() => {}); } }, { once: true });
    aud.load();
    return;
  }
  if (aud.readyState >= 1 && Math.abs(aud.currentTime - hit.offset) > 0.3) aud.currentTime = hit.offset;
  if (aud.paused && aud.readyState >= 1) aud.play().catch(() => {});
}
function playTick(now) {
  if (!S.playing) return;
  const end = Math.max(S.bounds.last_ms || 0, Date.now() - 1000);
  S.T = Math.min(S.T + (now - playLast), end);
  playLast = now;
  S.follow = false;
  drawTrack();
  updateClock();
  if (now - frameSyncAt > 250) { frameSyncAt = now; syncFrame(); }
  syncAudio();
  if (S.T >= end) { setPlaying(false); return; }
  playRaf = requestAnimationFrame(playTick);
}
function setPlaying(on) {
  if (on === S.playing) return;
  if (on && !S.bounds.count) return;
  S.playing = on;
  cancelAnimationFrame(playRaf);
  if (on) {
    stopMomentum();
    // At the newest moment there is nothing ahead to play: start one minute back.
    if (S.T >= (S.bounds.last_ms || 0) - 1000) S.T = Math.max(S.bounds.first_ms || S.T, S.T - 60000);
    playLast = performance.now();
    playRaf = requestAnimationFrame(playTick);
  }
  syncAudio();
  paintPlay();
}
function setMuted(on) {
  S.muted = on;
  try { localStorage.setItem('kmem.muted', on ? '1' : '0'); } catch (_) {}
  paintPlay();
}
$('#btn-play').onclick = () => setPlaying(!S.playing);
$('#btn-mute').onclick = () => setMuted(!S.muted);
paintPlay();

/* ---------- header actions ---------- */
function setHideHl(v) {
  S.hideHl = v;
  ocr.classList.toggle('hide-hl', v);
  const b = $('#btn-hl');
  b.setAttribute('aria-pressed', String(v));
  b.innerHTML = icon(v ? 'textoff' : 'text');
  b.title = v ? 'Show text highlights' : 'Hide text highlights';
}
$('#btn-hl').onclick = () => setHideHl(!S.hideHl);
$('#btn-copy').onclick = () => { if (S.frameId != null) { post({ cmd: 'copy_image', id: S.frameId }); toast('Screenshot copied'); } };
$('#btn-open').onclick = () => S.frame?.url && post({ cmd: 'open_page', url: S.frame.url });
$('#btn-search').onclick = () => openSearch();
$('#btn-settings').onclick = () => openSettings();

/* ---------- search ---------- */
const searchEl = $('#search');
const panelOpen = () => !searchEl.hidden || !$('#settings').hidden || !$('#onboarding').hidden;
let searchBuilt = false, results = [], total = 0, offset = 0, loading = false, searchSeq = 0, heat = null;

function buildSearch() {
  searchBuilt = true;
  searchEl.innerHTML = `
    <div class="panel-head">
      <button class="icon-btn" id="s-back" title="Back to timeline (Esc)">${icon('back')}</button>
      <label class="search-input">${icon('search')}<input id="s-q" type="text" placeholder="Search text, apps, and websites" spellcheck="false" autocomplete="off"></label>
    </div>
    <div class="filters" id="s-filters"></div>
    <div class="panel-body" id="s-body"></div>`;
  $('#s-back').onclick = closePanels;
  const input = $('#s-q');
  let t;
  input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { S.q = input.value.trim(); runSearch(true); }, 180); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(t); S.q = input.value.trim(); runSearch(true); } });
  $('#s-body').addEventListener('scroll', () => {
    const b = $('#s-body');
    if (b.scrollTop + b.clientHeight > b.scrollHeight - 400) runSearch(false);
  });
  renderFilters();
}
function openSearch(q) {
  $('#settings').hidden = true;
  if (!searchBuilt) buildSearch();
  searchEl.hidden = false;
  const input = $('#s-q');
  if (q != null) { input.value = q; S.q = q; }
  input.focus(); input.select();
  runSearch(true);
}
function closePanels() {
  closePop();
  searchEl.hidden = true;
  $('#settings').hidden = true;
}
const hasFilters = () => S.filters.app.length || S.filters.domain.length || S.filters.from != null;
function filterQuery(extra = {}) {
  const p = new URLSearchParams();
  if (S.q) p.set('q', S.q);
  if (S.filters.app.length) p.set('app', S.filters.app.join(','));
  if (S.filters.domain.length) p.set('domain', S.filters.domain.join(','));
  if (S.filters.from != null) p.set('from', S.filters.from);
  if (S.filters.to != null) p.set('to', S.filters.to);
  for (const [k, v] of Object.entries(extra)) p.set(k, v);
  return p.toString();
}

async function runSearch(reset) {
  if (reset) { results = []; total = 0; offset = 0; searchSeq++; }
  else if (loading || offset >= total) return;
  if (!S.q && !hasFilters()) { renderResults(true); return; }
  const seq = searchSeq;
  loading = true;
  try {
    const r = await api('/api/search?' + filterQuery({ offset, limit: 48 }));
    if (seq !== searchSeq) return;
    results = results.concat(r.results);
    total = r.total;
    offset = results.length;
    renderResults(false, !reset);
  } catch (e) { console.error(e); if (seq === searchSeq) renderResults(false); }
  loading = false;
}

const dayKeyOf = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
function highlightSnippet(s) {
  return esc(s).replace(/\u0001/g, '<mark>').replace(/\u0002/g, '</mark>');
}
function cardHtml(r, i) {
  const d = new Date(r.t);
  if (r.source === 'audio') {
    return `<button class="card" data-i="${i}">
    <div class="thumb audio" data-r="1">${icon('wave')}</div>
    <div class="card-body">
      <div class="card-title">Heard</div>
      <div class="card-time">${esc(fmtDay.format(d))}, ${esc(fmtHM.format(d))}  ·  audio</div>
      ${r.snippet ? `<div class="card-snip">${highlightSnippet(r.snippet)}</div>` : ''}
    </div></button>`;
  }
  const app = r.app;
  return `<button class="card" data-i="${i}">
    <div class="thumb" data-id="${r.id}" data-removed="${r.removed ? 1 : 0}"><span>${r.removed ? 'Removed to save storage' : ''}</span>
      ${r.removed ? '' : `<img loading="lazy" src="/media/thumb/${r.id}" alt="">`}
      ${app ? `<span class="badge app-icon">${iconHtml(app, app.name)}</span>` : ''}
    </div>
    <div class="card-body">
      <div class="card-title">${esc(r.title || app?.name || 'Untitled')}</div>
      <div class="card-time">${esc(fmtDay.format(d))}, ${esc(fmtHM.format(d))}${app ? '  ·  ' + esc(app.name) : ''}${r.domain ? '  ·  ' + esc(r.domain.name) : ''}</div>
      ${r.snippet ? `<div class="card-snip">${highlightSnippet(r.snippet)}</div>` : ''}
    </div></button>`;
}
function renderResults(initial, append) {
  const body = $('#s-body');
  if (initial) {
    body.innerHTML = `<div class="empty"><span>Results will show up here.</span><span>Words that were on your screen, and spoken words when audio transcription is on, are searchable. Use <span class="mono">AND</span>, <span class="mono">OR</span>, <span class="mono">NOT</span>, <span class="mono">"exact phrase"</span> and <span class="mono">prefix*</span>.</span></div><div class="heat-wrap" id="heat"></div>`;
    renderHeatmap();
    return;
  }
  if (!results.length) {
    const day = S.filters.from != null;
    body.innerHTML = `<div class="empty"><span>Nothing matches this search.${day ? ' Select a different day on the heatmap.' : ' Try other words.'}</span></div>${day ? '<div class="heat-wrap" id="heat"></div>' : ''}`;
    if (day) renderHeatmap();
    return;
  }
  if (append && $('#s-grid')) {
    const start = $('#s-grid').children.length;
    $('#s-grid').insertAdjacentHTML('beforeend', results.slice(start).map((r, i) => cardHtml(r, start + i)).join(''));
  } else {
    body.innerHTML = `<div class="grid" id="s-grid">${results.map(cardHtml).join('')}</div>`;
    body.scrollTop = 0;
  }
  bindThumbs();
}
function bindThumbs() {
  for (const im of document.querySelectorAll('.thumb img:not([data-b])')) {
    im.dataset.b = '1';
    im.addEventListener('error', () => { im.remove(); });
    im.addEventListener('load', () => { const s = im.parentElement.firstElementChild; if (s && s.tagName === 'SPAN') s.textContent = ''; });
  }
  for (const th of document.querySelectorAll('.thumb:not([data-r])')) {
    th.dataset.r = '1';
    if (th.dataset.removed !== '1') th.firstElementChild.textContent = 'Screenshot missing';
  }
}
$('#search').addEventListener('click', (e) => {
  const card = e.target.closest('.card');
  if (!card) return;
  const r = results[+card.dataset.i];
  S.terms = termsOf(S.q);
  closePanels();
  S.T = r.t;
  S.follow = false;
  drawTrack();
  if (r.id != null) showFrame(r.id).then(() => drawTrack());
  // A spoken match plays from where the words were said.
  if (r.source === 'audio') { invalidateSegments(); ensureSegments().then(() => setPlaying(true)); }
});

async function renderHeatmap() {
  const el = $('#heat');
  if (!el) return;
  try {
    const q = new URLSearchParams();
    if (S.q) q.set('q', S.q);
    if (S.filters.app.length) q.set('app', S.filters.app.join(','));
    if (S.filters.domain.length) q.set('domain', S.filters.domain.join(','));
    q.set('tz', TZ());
    heat = await api('/api/heatmap?' + q);
  } catch (e) { return; }
  const el2 = $('#heat');
  if (!el2) return;
  const counts = new Map(heat.days.map(([d, c]) => [new Date(d * 86400000).toISOString().slice(0, 10), c]));
  const max = Math.max(1, ...counts.values());
  const level = (c) => (!c ? 0 : Math.max(1, Math.ceil((c / max) * 4)));
  const end = new Date(); end.setHours(0, 0, 0, 0);
  const start = new Date(end); start.setDate(start.getDate() - 7 * 30 - end.getDay());
  const cells = [];
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const k = dayKeyOf(d.getTime());
    const c = counts.get(k) || 0;
    cells.push(`<button data-l="${level(c)}" data-day="${d.getTime()}" title="${esc(fmtDate.format(d))}: ${c} ${c === 1 ? 'frame' : 'frames'}"></button>`);
  }
  el2.innerHTML = `<p class="heat-title">Activity in the last 31 weeks</p><div class="heat">${cells.join('')}</div>`;
  el2.onclick = (e) => {
    const b = e.target.closest('button[data-day]');
    if (!b) return;
    const s = +b.dataset.day;
    S.filters.from = s; S.filters.to = s + 86400000;
    renderFilters(); runSearch(true);
  };
  S.heatCounts = counts;
}

/* filter chips + popovers */
let pop = null;
function closePop() { if (pop) { pop.remove(); pop = null; } }
document.addEventListener('pointerdown', (e) => { if (pop && !pop.contains(e.target) && !e.target.closest('.chip')) closePop(); }, true);

function chip(id, ic, label, on, onClear) {
  return `<button class="chip${on ? ' on' : ''}" id="${id}">${icon(ic)}<span>${esc(label)}</span>${on ? `<span class="x" data-clear="${id}">${icon('x')}</span>` : ''}</button>`;
}
function dateLabel() {
  const f = S.filters;
  if (f.from == null) return 'Any time';
  const a = new Date(f.from), b = new Date(f.to - 1);
  return dayKeyOf(a) === dayKeyOf(b) ? fmtDay.format(a) : `${fmtDay.format(a)} – ${fmtDay.format(b)}`;
}
function renderFilters() {
  const f = S.filters;
  $('#s-filters').innerHTML =
    chip('f-app', 'app', f.app.length ? (f.app.length === 1 ? (f.appNames?.[f.app[0]] || f.app[0]) : f.app.length + ' apps') : 'App', f.app.length) +
    chip('f-domain', 'globe', f.domain.length ? (f.domain.length === 1 ? f.domain[0] : f.domain.length + ' websites') : 'Website', f.domain.length) +
    chip('f-date', 'cal', dateLabel(), f.from != null);
  $('#f-app').onclick = (e) => { if (!clearChip(e)) listPop('#f-app', 'apps'); };
  $('#f-domain').onclick = (e) => { if (!clearChip(e)) listPop('#f-domain', 'domains'); };
  $('#f-date').onclick = (e) => { if (!clearChip(e)) datePop('#f-date'); };
}
function clearChip(e) {
  const x = e.target.closest('[data-clear]');
  if (!x) return false;
  e.stopPropagation();
  const id = x.dataset.clear;
  if (id === 'f-app') S.filters.app = [];
  if (id === 'f-domain') S.filters.domain = [];
  if (id === 'f-date') { S.filters.from = null; S.filters.to = null; }
  closePop(); renderFilters(); runSearch(true);
  return true;
}
function place(p, anchorSel) {
  const r = $(anchorSel).getBoundingClientRect();
  document.body.appendChild(p);
  p.style.left = Math.min(r.left, window.innerWidth - p.offsetWidth - 12) + 'px';
  p.style.top = r.bottom + 6 + 'px';
}
async function listPop(anchor, kind) {
  if (pop && pop.dataset.kind === kind) { closePop(); return; }
  closePop();
  const data = await api('/api/' + kind);
  const isApp = kind === 'apps';
  const items = (isApp ? data.apps : data.domains).map((x) => ({ key: isApp ? x.bundle : x.name, name: isApp ? x.name || x.bundle : x.name, app: isApp ? x : null }));
  if (isApp) { S.filters.appNames = Object.fromEntries(items.map((i) => [i.key, i.name])); }
  const sel = isApp ? S.filters.app : S.filters.domain;
  const p = document.createElement('div');
  p.className = 'pop'; p.dataset.kind = kind;
  p.innerHTML = `<input class="filter" placeholder="${isApp ? 'Filter apps' : 'Filter websites'}"><div class="pop-list"></div>`;
  const list = $('.pop-list', p);
  const paint = () => {
    const q = $('.filter', p).value.toLowerCase();
    const rows = items.filter((i) => i.name.toLowerCase().includes(q) || i.key.toLowerCase().includes(q));
    list.innerHTML = rows.length ? rows.map((i) => `<div class="pop-item${sel.includes(i.key) ? ' sel' : ''}" data-k="${esc(i.key)}"><span class="check">${icon('check')}</span>${isApp ? `<span class="app-icon">${iconHtml(i.app, i.name)}</span>` : ''}<span class="name">${esc(i.name)}</span></div>`).join('') : `<div class="pop-empty">${isApp ? 'Apps' : 'Websites'} will show up here</div>`;
  };
  $('.filter', p).addEventListener('input', paint);
  list.addEventListener('click', (e) => {
    const it = e.target.closest('.pop-item');
    if (!it) return;
    const k = it.dataset.k, i = sel.indexOf(k);
    if (i >= 0) sel.splice(i, 1); else sel.push(k);
    paint(); renderFilters(); runSearch(true);
  });
  paint();
  place(p, anchor);
  pop = p;
  $('.filter', p).focus();
}

async function datePop(anchor) {
  if (pop && pop.dataset.kind === 'date') { closePop(); return; }
  closePop();
  const q = new URLSearchParams({ tz: TZ() });
  if (S.q) q.set('q', S.q);
  if (S.filters.app.length) q.set('app', S.filters.app.join(','));
  if (S.filters.domain.length) q.set('domain', S.filters.domain.join(','));
  const h = await api('/api/heatmap?' + q);
  const counts = new Map(h.days.map(([d, c]) => [new Date(d * 86400000).toISOString().slice(0, 10), c]));
  const max = Math.max(1, ...counts.values());
  let cur = S.filters.from != null ? new Date(S.filters.from) : new Date();
  let y = cur.getFullYear(), m = cur.getMonth();
  let anchorDay = null;
  const p = document.createElement('div');
  p.className = 'pop'; p.dataset.kind = 'date'; p.style.width = '300px';
  const years = () => { const now = new Date().getFullYear(); const first = S.bounds.count ? new Date(S.bounds.first_ms).getFullYear() : now; const a = []; for (let i = now; i >= Math.min(first, now); i--) a.push(i); if (!a.includes(y)) a.push(y); return a; };
  const paint = () => {
    const first = new Date(y, m, 1), days = new Date(y, m + 1, 0).getDate();
    const names = Array.from({ length: 12 }, (_, i) => new Intl.DateTimeFormat(undefined, { month: 'long' }).format(new Date(2000, i, 1)));
    const dows = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
    let cells = '';
    for (let i = 0; i < first.getDay(); i++) cells += '<button class="cal-day pad"></button>';
    const f = S.filters.from, t = S.filters.to;
    for (let d = 1; d <= days; d++) {
      const dt = new Date(y, m, d), k = dayKeyOf(dt.getTime()), c = counts.get(k) || 0;
      const l = !c ? 0 : Math.max(1, Math.ceil((c / max) * 3));
      const s = dt.getTime();
      const inRange = f != null && s >= f && s < t;
      const single = f != null && t - f <= 86400000 + 3600000;
      cells += `<button class="cal-day${c ? '' : ' none'}${inRange ? (single ? ' sel' : ' sel') : ''}" data-l="${l}" data-s="${s}" title="${c} frames">${d}</button>`;
    }
    p.innerHTML = `<div class="cal-head"><button class="icon-btn" data-nav="-1">${icon('left')}</button>
      <span><select data-m>${names.map((n, i) => `<option value="${i}"${i === m ? ' selected' : ''}>${n}</option>`).join('')}</select>
      <select data-y>${years().map((v) => `<option${v === y ? ' selected' : ''}>${v}</option>`).join('')}</select></span>
      <button class="icon-btn" data-nav="1">${icon('right')}</button></div>
      <div class="cal-grid">${dows.map((d) => `<div class="cal-dow">${d}</div>`).join('')}${cells}</div>
      <div class="cal-foot"><span>${anchorDay != null ? 'Select the last day of the range' : 'Select a day, then another for a range'}</span><button class="btn" data-clear-date>Clear dates</button></div>`;
  };
  p.addEventListener('click', (e) => {
    const nav = e.target.closest('[data-nav]');
    if (nav) { m += +nav.dataset.nav; if (m < 0) { m = 11; y--; } if (m > 11) { m = 0; y++; } paint(); return; }
    if (e.target.closest('[data-clear-date]')) { S.filters.from = S.filters.to = null; closePop(); renderFilters(); runSearch(true); return; }
    const day = e.target.closest('.cal-day[data-s]');
    if (!day) return;
    const s = +day.dataset.s;
    if (anchorDay == null) { anchorDay = s; S.filters.from = s; S.filters.to = s + 86400000; }
    else { const a = Math.min(anchorDay, s), b = Math.max(anchorDay, s); S.filters.from = a; S.filters.to = b + 86400000; anchorDay = null; closePop(); }
    renderFilters(); runSearch(true); if (pop) paint();
  });
  p.addEventListener('change', (e) => {
    if (e.target.matches('[data-m]')) m = +e.target.value;
    if (e.target.matches('[data-y]')) y = +e.target.value;
    paint();
  });
  paint();
  place(p, anchor);
  pop = p;
}

let appData = null;
const MAC = PC === 'Mac';

/* ---------- onboarding: a personal install with nothing connected ---------- */
const obEl = $('#onboarding');
const OB = { active: false, signedIn: false, sawJob: false, permissionSkipped: false, requested: false, issuer: '', error: '', poll: 0 };
function showOnboarding(on) {
  obEl.hidden = !on;
  OB.active = on;
  clearInterval(OB.poll);
  if (!on) return;
  obTick();
  OB.poll = setInterval(obTick, 1500);
}
async function obTick() {
  try {
    const [app, sync] = await Promise.all([api('/api/app'), api('/api/sync')]);
    appData = app;
    const job = sync.jobs?.connect || null;
    if (job?.running) OB.sawJob = true;
    // Signed in during this onboarding: the "done" step stays until the person closes it.
    if (OB.sawJob && job && !job.running && job.ok === true && sync.view?.destination === 'kortix') OB.signedIn = true;
    if (job && !job.running && job.ok === false) OB.error = job.error || '';
    // Connected somewhere else (the command line, IT): nothing left to ask.
    if (!app.onboarding && !OB.signedIn) return showOnboarding(false);
    const step = onboardingStep(app, job, sync.view, { mac: MAC, signedIn: OB.signedIn, permissionSkipped: OB.permissionSkipped });
    paintOnboarding(step, job, sync, app);
  } catch (e) { console.error(e); }
}
function paintOnboarding(step, job, sync, app) {
  const icon = '<img class="ob-icon" src="/brand/app-icon.png" alt="">';
  const err = OB.error ? `<p class="ob-err">${esc(OB.error)}</p>` : '';
  let body;
  if (step === 'permission') {
    body = `<h1>Allow access</h1>
      <button class="btn primary" id="ob-grant"${OB.requested ? ' disabled' : ''}>${OB.requested ? 'Waiting for permission...' : 'Allow access'}</button>
      <div class="ob-foot"><button class="link-btn" id="ob-perm-skip">Not now</button></div>`;
  } else if (step === 'waiting') {
    const p = job?.progress;
    body = `<h1>Approve in your browser</h1>
      ${p ? `<div class="ob-code mono" id="ob-code">${esc(p.user_code)}</div><button class="btn" id="ob-approve">Open approval page</button>` : '<p class="ob-sub">Starting...</p>'}`;
  } else if (step === 'done') {
    const who = sync.status?.kortix?.account_name;
    body = `<h1>${esc(who ? `Recording and syncing to ${who}.` : 'Recording and syncing to Kortix.')}</h1>
      <button class="btn primary" id="ob-close">Close</button>`;
  } else {
    const needsUrl = app && (app.default_issuer_missing || OB.otherIssuer);
    body = `<h1>Connect to Kortix</h1>
      ${needsUrl ? `<label class="ob-field"><span>Kortix API address</span><input type="text" id="ob-issuer" class="mono" placeholder="${esc(app.issuer_url || 'https://api.kortix.com')}" value="${esc(OB.issuer)}" autocomplete="off" spellcheck="false"></label>` : ''}
      <button class="btn primary" id="ob-signin">Sign in with Kortix</button>${err}
      <div class="ob-foot">${needsUrl ? '' : `<button class="link-btn" id="ob-other">Use another Kortix address</button>`}<button class="link-btn" id="ob-s3">Use your own S3 bucket</button><button class="link-btn" id="ob-skip">Skip. Keep recordings on this ${esc(PC)}</button></div>`;
  }
  setHtml(obEl, `<div class="ob-card" data-step="${step}">${icon}${body}</div>`);
}
obEl.addEventListener('input', (e) => { if (e.target.id === 'ob-issuer') OB.issuer = e.target.value; });
obEl.addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b || b.disabled) return;
  if (b.id === 'ob-other') { OB.otherIssuer = true; obTick(); return; }
  if (b.id === 'ob-signin') {
    OB.error = '';
    if (!(await act('/api/kortix/connect', { issuer: OB.issuer.trim() }, true))) { OB.error = actError; }
    obTick();
  } else if (b.id === 'ob-approve') {
    const j = (await api('/api/sync')).jobs?.connect;
    if (j?.progress?.approve_url) post({ cmd: 'open_url', url: j.progress.approve_url });
  } else if (b.id === 'ob-grant') {
    OB.requested = true;
    await act('/api/app/permissions');
    obTick();
  } else if (b.id === 'ob-perm-skip') { OB.permissionSkipped = true; obTick(); }
  else if (b.id === 'ob-skip') { await act('/api/app/onboarding', { state: 'skipped' }); showOnboarding(false); refreshBounds(); }
  else if (b.id === 'ob-close') { await act('/api/app/onboarding', { state: 'done' }); showOnboarding(false); refreshBounds(); paintChip(); }
  else if (b.id === 'ob-s3') { showOnboarding(false); openSettings('s3'); }
});

/* ---------- the status chip: recording, paused or needs permission ---------- */
const chipEl = $('#status-chip');
function paintChip() {
  if (!appData) return;
  const v = statusView(appData.state, settingsData?.status?.paused_until_ms, (d) => fmtHM.format(d));
  const html = `<span class="status-dot${v.tone ? ' ' + v.tone : ''}"></span>${esc(v.text)}`;
  setHtml(chipEl, html);
  chipEl.dataset.state = appData.state;
  const perm = $('#perm-line');
  if (perm) {
    const screen = appData.state === 'permission_missing';
    const inputs = !screen && inputsMissing(appData);
    perm.hidden = !screen && !inputs;
    setHtml(perm, `<span>${screen ? 'Screen Recording is off.' : 'Keyboard and mouse recording is off.'}</span><button class="btn" id="perm-grant">Grant</button>`);
  }
}
$('#perm-line').addEventListener('click', async (e) => {
  if (e.target.closest('#perm-grant')) { await act('/api/app/permissions'); toast('Turn on Kortix Capture in System Settings'); }
});
async function refreshApp() {
  try {
    appData = await api('/api/app');
    if (!settingsEl.hidden) paintRecording();
    paintChip();
  } catch (e) { console.error(e); }
}
chipEl.onclick = async () => {
  if (appData?.state === 'permission_missing') { await act('/api/app/permissions'); toast('Turn on Kortix Capture in System Settings'); return; }
  openSettings();
};

/* ---------- settings ---------- */
/* A thin client: every value is checked and saved by /api/settings (the same
   `Settings::validate` as `kortix-capture settings`). Five sections, nothing else:
   Recording, Sync, Privacy, Storage, About, and a folded Advanced. Every error a person
   sees is one short sentence; the detail is in the log. */
const settingsEl = $('#settings');
let settingsData = null, syncData = null, saveTimer = 0, pending = {}, livePoll = 0;
const draft = { forget: null, audioDevices: null, dest: null, s3: null, issuer: '', syncError: '', syncErrorAdv: false, confirmOff: null, busy: '' };

async function openSettings(dest, section) {
  draft.dest = dest || null;
  draft.syncError = '';
  draft.confirmOff = null;
  // A destination to set up (onboarding's "your own S3 bucket") lives under Advanced.
  if (dest) { draft.adv = true; section = 'sync-dest'; }
  closePop();
  searchEl.hidden = true;
  settingsEl.hidden = false;
  await loadSettings();
  // "never" and "only" were sections of their own; both are Apps and websites now.
  if (section) $(`#sec-${section === 'never' || section === 'only' ? 'apps' : section}`)?.scrollIntoView();
  clearInterval(livePoll);
  // Live account, status and sign-in progress while the panel is open.
  livePoll = setInterval(() => {
    if (settingsEl.hidden) { clearInterval(livePoll); return; }
    refreshLive();
  }, 2000);
}
async function loadAudioDevices() {
  try { draft.audioDevices = await api('/api/audio/devices'); } catch (e) { draft.audioDevices = { devices: [], error: e.message }; }
  if (!settingsEl.hidden) renderSettings();
}
/* Apps and websites to suggest where a person includes or excludes one: installed apps
   (macOS), recorded apps and recorded websites. Loaded once per window. */
let suggest = null;
async function loadSuggestions() {
  const [inst, rec, dom] = await Promise.all([api('/api/installed-apps').catch(() => ({})), api('/api/apps').catch(() => ({})), api('/api/domains').catch(() => ({}))]);
  suggest = suggestionList(inst.apps, rec.apps, dom.domains);
  const dl = $('#app-site-suggest');
  if (dl) setHtml(dl, suggestOptions());
}
const suggestOptions = () => (suggest || []).map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('');
/* An app or website row, by its name when this computer knows it. */
function appRow(r) {
  const name = r.kind === 'app' ? (suggest || []).find((o) => o.value.toLowerCase() === String(r.id).toLowerCase())?.label : null;
  return { ...r, label: name || r.label || r.id, sub: [r.sub, name ? r.id : ''].filter(Boolean).join(' · ') };
}
async function loadSettings() {
  if (draft.audioDevices == null) { draft.audioDevices = { devices: [] }; loadAudioDevices(); }
  if (suggest == null) { suggest = []; loadSuggestions().then(() => settingsData && renderSettings()); }
  const [settings, sync, app] = await Promise.all([api('/api/settings'), api('/api/sync'), api('/api/app')]);
  settingsData = settings;
  syncData = sync;
  appData = app;
  renderSettings();
  paintChip();
}
async function refreshLive() {
  try {
    const [sync, app, st] = await Promise.all([api('/api/sync'), api('/api/app'), api('/api/status')]);
    const was = syncData?.jobs?.connect;
    syncData = sync;
    appData = app;
    settingsData.status = st;
    paintSync();
    paintRecording();
    paintChip();
    const j = sync.jobs?.connect;
    if (was?.running && j && !j.running) {
      if (j.ok) { draft.syncError = ''; toast('Signed in. Sync is on.'); await loadSettings(); }
      else if (j.error) { draft.syncError = j.error; draft.syncErrorAdv = false; paintSync(); }
    }
  } catch (e) { console.error(e); }
}
/* Save a settings patch. Patches made within 200 ms go out together. */
function patch(p) {
  deepMerge(settingsData.settings, JSON.parse(JSON.stringify(p)));
  deepMerge(pending, p);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const body = pending;
    pending = {};
    try {
      await api('/api/settings', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
      toast('Settings saved');
      const s = await api('/api/settings');
      settingsData.status = s.status;
      paintRecording();
    } catch (e) {
      console.error(e);
      toast(e.message || 'Could not save the settings');
      await loadSettings(); // show the stored values again
    }
  }, 200);
}
/* POST an action; returns the JSON, or null after a toast with the server's reason (kept in `actError`). */
let actError = '';
async function act(path, body = {}, quiet = false) {
  try {
    return await api(path, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
  } catch (e) { actError = plainError(e.message); if (!quiet) toast(actError); return null; }
}
/* Repaint only when the markup changed, so a poll never resets a half-done confirm. */
function setHtml(el, html) { if (el._html !== html) { el._html = html; el.innerHTML = html; } }
const sw = (path, on, extra = '') => `<label class="switch"><input type="checkbox" data-path="${path}" data-type="bool"${on ? ' checked' : ''}${extra}><i></i></label>`;
const num = (path, v, { min, max, step = 1, type = 'int', scale } = {}) =>
  `<input type="number" data-path="${path}" data-type="${type}"${scale ? ` data-scale="${scale}"` : ''}${min != null ? ` min="${min}"` : ''}${max != null ? ` max="${max}"` : ''} step="${step}" value="${scale ? v / scale : v}">`;
const row = (label, help, control) => `<div class="row"><div class="lab">${label}${help ? `<small>${help}</small>` : ''}</div>${control}</div>`;
const orgName = () => syncData?.status?.kortix?.account_name || 'policy';
const policyPrivacy = () => (syncData?.view?.destination === 'kortix' ? syncData?.status?.policy?.policy?.privacy : null) || {};
function gb(b) { return b >= 1e9 ? (b / 1e9).toFixed(2) + ' GB' : (b / 1e6).toFixed(1) + ' MB'; }

/* Repaint `el` only when `key` changed, so a poll never wipes text a person is typing. */
function setKeyed(el, key, html) {
  if (el._key === key) return;
  el._key = key;
  el.innerHTML = html;
}
const field = (id, label, value, { type = 'text', ph = '', mono = true } = {}) =>
  `<label class="field"><span>${label}</span><input type="${type}" id="${id}" class="${mono ? 'mono' : ''}" value="${esc(value)}" placeholder="${esc(ph)}" autocomplete="off" spellcheck="false"></label>`;
const s3Draft = () => {
  if (draft.s3) return draft.s3;
  const st = syncData?.status || {}, s3 = settingsData?.settings?.sync?.s3 || {};
  draft.s3 = { endpoint: s3.endpoint || '', bucket: s3.bucket || '', region: s3.region || 'us-east-1', prefix: s3.prefix || 'kortix-capture',
    access_key_id: syncData?.credentials?.access_key_id || '', secret_access_key: '' };
  return draft.s3;
};
/* The Sync section says where recordings go, and offers the Kortix sign-in while sync is off.
   Advanced holds the destination picker, the S3 form and Sign out. */
function paintSync() {
  const box = $('#sync-box');
  if (!box || !syncData || !appData) return;
  const view = syncData.view || { destination: 'off', line: 'Off', tone: 'off' };
  if (!draft.dest) draft.dest = view.destination;
  const kortix = syncData.status?.kortix || {};
  const job = syncData.jobs?.connect;
  const errHtml = (adv) => (draft.syncError && draft.syncErrorAdv === adv ? `<div class="note err">${esc(draft.syncError)}</div>` : '');
  const main = syncPanel(appData, view, syncShown(view), kortix, job);
  let inner = '';
  switch (main.kind) {
    case 'managed': inner = `<div class="row"><div class="lab">${esc(main.title)}<small>${esc(main.sub)}</small></div></div>`; break;
    case 'kortix-wait': inner = `<div class="row"><div class="lab">Waiting for approval in your browser<small>${main.code ? `Code <span class="mono">${esc(main.code)}</span>. Check it matches, then approve.` : 'Starting sign-in...'}</small></div>${main.code ? '<button class="btn" id="kortix-approve">Open approval page</button>' : ''}</div>`; break;
    case 'kortix-in': inner = `<div class="row"><div class="lab">${esc(main.title)}${main.sub ? `<small>${esc(main.sub)}</small>` : ''}${appData.issuer_url ? `<small class="mono">${esc(appData.issuer_url)}</small>` : ''}</div></div>`; break;
    case 'kortix-out': inner = `${view.destination === 'off' ? `<p class="hint">Sync is off. Recordings are only on this ${PC}, with no copy anywhere else.</p>` : main.sub ? `<p class="hint">${esc(main.sub)}</p>` : ''}
      ${appData.default_issuer_missing || draft.otherIssuer ? field('kortix-issuer', 'Kortix API address', draft.issuer, { ph: appData.issuer_url || 'https://api.kortix.com' }) : ''}
      <div class="actions"><button class="btn primary" id="kortix-connect">Sign in with Kortix</button>${appData.default_issuer_missing || draft.otherIssuer ? '' : `<button class="link-btn" id="kortix-other">Use another Kortix address</button>`}</div>`; break;
    case 's3': inner = `<div class="row"><div class="lab">${esc(view.line || 'Your S3 bucket')}</div></div>`; break;
  }
  const mainKey = [main.kind, main.title || '', main.sub || '', main.code || '', view.destination, view.line || '', appData.default_issuer_missing, appData.issuer_url || '', !!draft.otherIssuer, draft.syncErrorAdv ? '' : draft.syncError].join('|');
  setKeyed(box, mainKey, inner + errHtml(false));
  // The status line follows the destination that is on now.
  const on = view.destination !== 'off';
  setHtml($('#sync-status'), on ? `<span class="status-dot ${view.tone === 'ok' ? 'live' : view.tone === 'error' ? 'err' : ''}"></span>${esc(view.line)}` : '');

  const adv = $('#sync-adv');
  if (!adv) return;
  if (appData.managed) { setKeyed(adv, 'managed', ''); return; }
  // Picking a destination changes nothing: a different one shows what it means and waits
  // for an explicit Save, and leaving Settings drops it.
  const now = view.destination, chosen = draft.dest, pending = chosen !== now;
  const seg = `<div class="seg" role="radiogroup" aria-label="Where recordings go">${DESTINATIONS.map(([k, n]) =>
    `<button type="button" role="radio" aria-checked="${chosen === k}" data-dest="${k}" class="${chosen === k ? 'on' : ''}">${n}${k === now ? ' <small>(on)</small>' : ''}</button>`).join('')}</div>`;
  const cancel = '<button class="btn" id="sync-cancel">Cancel</button>';
  const leaving = now !== 'off' ? ` Recordings stop going to ${now === 'kortix' ? 'Kortix' : 'your S3 bucket'}.` : '';
  const s3Form = () => {
    const f = s3Draft();
    return `<div class="form">
        ${field('s3-endpoint', 'Endpoint', f.endpoint, { ph: 'https://s3.us-east-1.amazonaws.com' })}
        ${field('s3-bucket', 'Bucket', f.bucket)}
        ${field('s3-region', 'Region', f.region)}
        ${field('s3-prefix', 'Folder', f.prefix)}
        ${field('s3-key', 'Access key ID', f.access_key_id)}
        ${field('s3-secret', 'Secret access key', f.secret_access_key, { type: 'password', ph: syncData.credentials?.saved ? 'Saved. Leave blank to keep it.' : '' })}
      </div>`;
  };
  const busy = draft.busy === 's3';
  let body = '';
  if (draft.confirmOff === 'signout') {
    body = `<div class="note warn"><strong>Sign out and stop syncing?</strong>
      New recordings stay only on this ${PC}. Nothing is backed up, and they are gone when this ${PC} is lost or reset.
      <div class="actions"><button class="btn" id="sync-keep">Keep syncing</button><button class="btn danger" id="sync-stop">Sign out</button></div></div>`;
  } else if (pending && chosen === 'off') {
    body = `<div class="note warn"><strong>Stop syncing?</strong>
      New recordings stay only on this ${PC}. Nothing is backed up, and they are gone when this ${PC} is lost or reset.
      <div class="actions">${cancel}<button class="btn danger" id="sync-stop">Stop syncing</button></div></div>`;
  } else if (pending && chosen === 's3') {
    body = `${s3Form()}<div class="note warn"><strong>Not saved.</strong> Switch to your S3 bucket?${leaving} Kortix Capture tests the bucket before it switches.
      <div class="actions">${cancel}<button class="btn primary" id="s3-save"${busy ? ' disabled' : ''}>${busy ? 'Testing...' : 'Save and switch'}</button></div></div>`;
  } else if (pending && chosen === 'kortix') {
    body = `<div class="note warn"><strong>Not saved.</strong> Switch to Kortix?${leaving} Sign in to switch.
      <div class="actions">${cancel}<button class="btn primary" id="kortix-connect">Sign in with Kortix</button></div></div>`;
  } else if (chosen === 's3') {
    body = `${s3Form()}<div class="actions"><button class="btn" id="s3-save"${busy ? ' disabled' : ''}>${busy ? 'Testing...' : 'Save changes'}</button></div>`;
  } else if (chosen === 'kortix') {
    body = row('Sign out of Kortix', 'Stops sync. Recording continues.', '<button class="btn" id="kortix-signout">Sign out</button>');
  } else {
    body = `<p class="hint">Recordings stay on this ${PC}.</p>`;
  }
  const rule = pending && chosen !== 'off' ? `<p class="hint small">${esc(syncData.switch_rule || '')}</p>` : '';
  const advKey = [now, chosen, draft.confirmOff || '', !!appData.signed_in, draft.busy, !!syncData.credentials?.saved, draft.syncErrorAdv ? draft.syncError : ''].join('|');
  setKeyed(adv, advKey, `<div class="row stack"><div class="lab">Sync destination<small>Where recordings go. Nothing changes until you save.</small></div></div>${seg}${body}${rule}${errHtml(true)}`);
}
/* The status line and the pause control: repainted by the poll. */
function paintRecording() {
  const box = $('#rec-box');
  if (!box || !settingsData || !appData) return;
  const s = settingsData.settings, st = settingsData.status;
  const paused = st.paused_until_ms && st.paused_until_ms > Date.now();
  const v = statusView(appData.state, st.paused_until_ms, (d) => fmtHM.format(d));
  const off = !s.recording_enabled;
  const notice = policyText(syncData?.status?.policy);
  const control = appData.managed ? ''
    : paused || off ? '<button class="btn" id="resume-btn">Resume</button>'
    : `<span><select id="pause-for">${PAUSE_CHOICES.map(([k, n]) => `<option value="${k}"${k === '1h' ? ' selected' : ''}>${n}</option>`).join('')}</select> <button class="btn" id="pause-btn">Pause</button></span>`;
  const label = `<span class="status-dot${v.tone ? ' ' + v.tone : ''}"></span>${esc(off ? 'Recording is off' : v.text)}`;
  setHtml(box, row(label, appData.managed && notice ? esc(notice) : '', control)
    + (appData.state === 'permission_missing' ? `<div class="note">Screen Recording is off. <button class="btn" id="grant-btn">Grant</button></div>` : inputsMissing(appData) ? `<div class="note">Keyboard and mouse recording is off. <button class="btn" id="grant-btn">Grant</button></div>` : ''));
  const au = $('#audio-state');
  if (au) {
    const on = s.audio.enabled && st.audio && st.audio.state === 'recording';
    au.innerHTML = `<span class="status-dot${on ? ' live' : ''}"></span>${esc(audioStateText(s.audio.enabled, st.audio))}`;
  }
}
function neverRow(r) {
  const glyph = r.locked ? icon('lock').replace('<svg ', '<svg class="lock" ') : '';
  const name = `<span class="name${r.kind === 'app' || r.kind === 'site' ? ' mono' : ''}">${glyph}${esc(r.label)}</span>`;
  const lab = `<div class="lab">${name}${r.sub ? `<small>${esc(r.sub)}</small>` : ''}</div>`;
  let ctl = '';
  if (!r.locked) {
    if (r.kind === 'group') ctl = `<label class="switch"><input type="checkbox" data-group="${esc(r.id)}"${r.on ? ' checked' : ''} aria-label="${esc(r.label)}"><i></i></label>`;
    else if (r.kind === 'private') ctl = sw('exclude_private_browsing', r.on, ' aria-label="Private browsing windows"');
    else ctl = `<button class="rm" data-rm="${esc(r.key)}" data-v="${esc(r.id)}" title="Remove ${esc(r.id)}">${icon('x')}</button>`;
  }
  return `<div class="row">${lab}${ctl}</div>`;
}
function renderSettings() {
  const s = settingsData.settings, st = settingsData.status, g = settingsData.groups;
  const res = settingsData.resolution;
  const pp = policyPrivacy();
  const orgKnown = syncData?.status?.kortix?.account_name || '';
  const never = neverRows(s, g, pp, orgKnown);
  const managed = !!appData?.managed;
  const items = exclusionItems(s, pp);
  const only = onlyIncluded(s, pp, orgKnown);
  const keep = keepChoice(s.storage);
  const audioBlocked = syncData?.layers?.audio?.blocked_by;
  const scroll = $('.panel-body', settingsEl)?.scrollTop || 0;
  const by = esc(orgName());
  // Frame interval and size the organization's policy sets: shown, locked (only while synced to it).
  const orgRec = (syncData?.view?.destination === 'kortix' ? syncData?.status?.policy?.policy?.recording : null) || {};
  settingsEl.innerHTML = `
    <div class="panel-head"><button class="icon-btn" id="set-back" title="Back (Esc)">${icon('back')}</button><strong>Settings</strong></div>
    <div class="panel-body"><div class="settings">
      <h3 id="sec-recording">Recording</h3>
      <div id="rec-box"></div>
      ${audioBlocked ? '' : audioHtml(s)}

      <h3 id="sec-sync">Sync</h3>
      <div id="sync-status" class="sync-status"></div>
      <div id="sync-box"></div>

      <h3 id="sec-apps">Apps and websites</h3>
      <p class="hint">Choose what Kortix Capture records. What it skips is blacked out and never saved or uploaded. Never record always wins.</p>
      ${only.locked || never.some((r) => r.locked) ? `<p class="hint">${esc(orgKnown ? orgKnown + ' requires the locked ones.' : 'Policy requires the locked ones.')}</p>` : ''}
      <div class="never">
        ${row(`What to record${only.sub ? `<small>${esc(only.sub)}</small>` : ''}`, '', only.locked
          ? `<span>${icon('lock').replace('<svg ', '<svg class="lock" ')}Only included apps and websites</span>`
          : `<select id="rec-mode" aria-label="What to record"><option value="all"${only.on ? '' : ' selected'}>Everything except Never record</option><option value="only"${only.on ? ' selected' : ''}>Only included apps and websites</option></select>`)}
        ${only.on ? `<div class="sub-h">Record</div>${only.rows.length ? '' : '<p class="hint">Nothing is included yet, so nothing is recorded. Add an app or a website.</p>'}${only.rows.map((r) => neverRow(appRow(r))).join('')}
        <div class="add-row"><input type="text" id="add-in" list="app-site-suggest" placeholder="Add an app or website to record" aria-label="Add an app or website to record" autocomplete="off" spellcheck="false"><button class="btn" id="add-in-btn">Add</button></div>` : ''}
        <div class="sub-h">Never record</div>
        ${never.map((r) => neverRow(r.kind === 'app' || r.kind === 'site' ? appRow(r) : r)).join('')}
        <div class="add-row"><input type="text" id="add-ex" list="app-site-suggest" placeholder="Add an app or website to skip" aria-label="Add an app or website to skip" autocomplete="off" spellcheck="false"><button class="btn" id="add-ex-btn">Add</button></div>
      </div>
      <datalist id="app-site-suggest">${suggestOptions()}</datalist>

      <h3 id="sec-storage">Storage</h3>
      ${row('Library size', esc(st.library), `<span>${gb(st.usage_total_bytes || 0)}</span>`)}
      ${row('Keep recordings on this computer', keepHint(keep, syncData?.view?.destination !== 'off', s.storage.limit_gb),
        `<select id="keep-for">${KEEP_CHOICES.map(([k, n]) => `<option value="${k}"${keep === k ? ' selected' : ''}>${n}</option>`).join('')}${keep === 'custom' ? '<option value="custom" selected>Custom (set with the command line)</option>' : ''}</select>`)}
      ${forgetHtml()}

      <h3 id="sec-about">About</h3>
      ${row('Version', '', `<span class="mono">${esc(appData?.version || '')}</span>`)}
      ${managed ? '' : row('Launch at login', 'Start Kortix Capture when you log in, and restart it if it quits unexpectedly.', sw('launch_at_login', s.launch_at_login !== false))}
      ${row('Logs', '', '<button class="btn" id="open-logs">Open logs</button>')}

      <details class="adv"${draft.adv ? ' open' : ''}><summary>Advanced</summary>
        <div id="sec-sync-dest"><div id="sync-adv"></div></div>
        ${orgRec.interval_ms != null
          ? row('Capture interval', `Set by ${by}.`, `<span>${orgRec.interval_ms / 1000} s</span>`)
          : row('Capture interval', '', `<span>${num('interval_ms', s.interval_ms, { min: 0.5, step: 0.5, type: 'float', scale: 1000 })} s</span>`)}
        ${orgRec.max_height != null
          ? row('Screenshot size', `Set by ${by}.`, `<span>${orgRec.max_height === 2160 ? '4K' : orgRec.max_height + 'p'}</span>`)
          : row('Screenshot size', 'Screenshots are scaled down to fit, never up.',
          `<select id="resolution">${settingsData.resolution_presets.map((p) => `<option value="${p.name}"${res === p.name ? ' selected' : ''}>${p.name} (${p.max_width} × ${p.max_height})</option>`).join('')}${res === 'custom' ? `<option value="custom" selected>Custom (${s.max_width} × ${s.max_height})</option>` : ''}</select>`)}
        ${row('Text recognition', 'Fast uses less power and misses more small text.', `<select data-path="ocr_level" data-type="str">${[['accurate', 'Accurate'], ['fast', 'Fast']].map(([k, n]) => `<option value="${k}"${s.ocr_level === k ? ' selected' : ''}>${n}</option>`).join('')}</select>`)}
      </details>
    </div></div>`;
  $('.panel-body', settingsEl).scrollTop = scroll;
  paintSync();
  paintRecording();
  bindSettings();
}

/* ---- audio: one switch and its consent sentence ---- */
function audioHtml(s) {
  const mic = draft.audioDevices?.microphone;
  const allow = s.audio.enabled && s.audio.microphone && mic && mic !== 'granted'
    ? `<div class="note">${mic === 'denied' ? 'Microphone access is turned off for Kortix Capture. Turn it on in System Settings, Privacy &amp; Security, Microphone.' : 'Kortix Capture needs your permission to use the microphone.'} <button class="btn" id="audio-allow">${mic === 'denied' ? 'Open settings' : 'Allow microphone'}</button></div>` : '';
  return row('Record audio<small id="audio-state"></small>',
      'Records everything this computer hears and plays, around the clock: your microphone and the sound of calls, videos and music, including other people on calls. Some places require everyone\'s consent before a conversation is recorded. Off until you turn it on.',
      sw('audio.enabled', s.audio.enabled, ' aria-label="Record audio"')) + allow;
}

/* ---- storage: forget a time range ---- */
function forgetHtml() {
  const f = { ...lastHour(Date.now()), ...(draft.forget || {}) };
  const r = f.report;
  const when = (ms) => (ms == null ? '-' : fmtDate.format(new Date(ms)) + ' ' + fmtHM.format(new Date(ms)));
  return `<div class="row stack"><div class="lab">Forget recent recordings<small>Deletes the frames, text, video, audio and action recordings in the range, here and in the cloud. Whole chunks go, so the range can grow a little.</small></div>
      <span class="forget"><input type="datetime-local" id="forget-from" value="${esc(f.from || '')}"> to <input type="datetime-local" id="forget-to" value="${esc(f.to || '')}"> <button class="btn" id="forget-preview">Preview</button></span></div>
    ${r ? `<div class="note${r.dry_run ? '' : ' ok'}">${r.dry_run
      ? `Deletes ${r.chunks} chunks, ${r.frames} frames${r.audio ? `, ${r.audio} audio segments` : ''}${r.actions ? `, ${r.actions} action recordings` : ''} from ${esc(when(r.start_ms))} to ${esc(when(r.end_ms))}${r.remote_objects_queued ? `, and ${r.remote_objects_queued} cloud objects` : ''}. This cannot be undone. <button class="btn danger" id="forget-yes" data-confirm="Delete for good">Delete</button>`
      : `Deleted ${r.chunks} chunks, ${r.frames} frames${r.audio ? `, ${r.audio} audio segments` : ''}${r.actions ? `, ${r.actions} action recordings` : ''}${r.remote_objects_queued ? `; ${r.remote_objects_queued} cloud objects are queued for deletion` : ''}.`}</div>` : ''}`;
}

/* Two-step confirm for destructive buttons: the first click arms, the second acts. */
function armed(btn) {
  if (btn.dataset.armed) return true;
  btn.dataset.armed = '1';
  const label = btn.textContent;
  btn.textContent = btn.dataset.confirm + '?';
  setTimeout(() => { if (btn.isConnected) { delete btn.dataset.armed; btn.textContent = label; } }, 4000);
  return false;
}
function bindSettings() {
  const s = settingsData.settings;
  $('#set-back').onclick = closePanels;
  const addEx = () => {
    const c = classifyExclusion($('#add-ex').value);
    if (!c) { toast('Enter an app such as com.example.App or a website such as example.com'); return; }
    const key = c.kind === 'site' ? 'excluded_domains' : 'excluded_bundle_ids';
    if (s[key].includes(c.value)) { toast('Already excluded'); return; }
    patch({ [key]: [...s[key], c.value] });
    renderSettings();
  };
  if ($('#add-ex-btn')) { $('#add-ex-btn').onclick = addEx; $('#add-ex').onkeydown = (e) => e.key === 'Enter' && addEx(); }
  const addIn = () => {
    const c = classifyExclusion($('#add-in').value);
    if (!c) { toast('Enter an app such as com.example.App or a website such as example.com'); return; }
    const key = c.kind === 'site' ? 'included_domains' : 'included_bundle_ids';
    const list = s[key] || [];
    if (list.includes(c.value)) { toast('Already included'); return; }
    patch({ [key]: [...list, c.value] });
    renderSettings();
  };
  if ($('#add-in-btn')) { $('#add-in-btn').onclick = addIn; $('#add-in').onkeydown = (e) => e.key === 'Enter' && addIn(); }
}
const SYNC_FIELDS = { 's3-endpoint': 'endpoint', 's3-bucket': 'bucket', 's3-region': 'region', 's3-prefix': 'prefix', 's3-key': 'access_key_id', 's3-secret': 'secret_access_key' };
settingsEl.addEventListener('input', (e) => {
  const t = e.target;
  if (SYNC_FIELDS[t.id]) { s3Draft()[SYNC_FIELDS[t.id]] = t.value; draft.syncError = ''; const er = $('#sync-err'); if (er) setHtml(er, ''); }
  if (t.id === 'kortix-issuer') draft.issuer = t.value;
  if (t.id === 'forget-from' || t.id === 'forget-to') draft.forget = { from: $('#forget-from').value, to: $('#forget-to').value };
});
settingsEl.addEventListener('toggle', (e) => {
  if (e.target.matches('details.adv')) draft.adv = e.target.open;
}, true);
settingsEl.addEventListener('change', async (e) => {
  const t = e.target, s = settingsData.settings;
  if (t.id === 'rec-mode') {
    patch({ record_only_included: t.value === 'only' });
    renderSettings();
    return;
  }
  if (t.id === 'keep-for') {
    const p = keepPatch(t.value);
    if (p) { patch(p); renderSettings(); }
    return;
  }
  if (t.id === 'resolution') {
    if (t.value !== 'custom') patch({ resolution: t.value });
    settingsData.resolution = t.value;
    renderSettings();
    return;
  }
  if (t.dataset.group) {
    const set = new Set(s.enabled_exclusion_groups);
    t.checked ? set.add(t.dataset.group) : set.delete(t.dataset.group);
    patch({ enabled_exclusion_groups: [...set] });
    return;
  }
  if (!t.dataset.path) return;
  let v = t.dataset.type === 'bool' ? t.checked : t.dataset.type === 'int' ? Number(t.value) : t.dataset.type === 'float' ? parseFloat(t.value) : t.value;
  if (typeof v === 'number' && Number.isNaN(v)) return;
  if (t.dataset.scale) v = Math.round(v * +t.dataset.scale);
  patch(pathPatch(t.dataset.path, v));
  if (t.dataset.path === 'audio.enabled') renderSettings();
});
settingsEl.addEventListener('click', async (e) => {
  const b = e.target.closest('button, [data-rm]');
  if (!b || b.disabled) return;
  const s = settingsData.settings;
  if (b.dataset.rm) {
    const key = b.dataset.rm;
    patch({ [key]: s[key].filter((x) => x !== b.dataset.v) });
    renderSettings();
    return;
  }
  if (b.dataset.dest) {
    const to = b.dataset.dest;
    draft.syncError = '';
    // A pick only marks the change; Save (or Stop syncing, or Sign in) applies it.
    draft.confirmOff = null; draft.dest = to;
    paintSync();
    return;
  }
  if (b.dataset.confirm && !armed(b)) return;
  switch (b.id) {
    case 'pause-btn':
      patch({ paused_until_ms: pauseUntil($('#pause-for').value, Date.now()), recording_enabled: true });
      setTimeout(loadSettings, 400);
      break;
    case 'resume-btn':
      patch({ paused_until_ms: null, recording_enabled: true });
      setTimeout(loadSettings, 400);
      break;
    case 'grant-btn': await act('/api/app/permissions'); toast('Turn on Kortix Capture in System Settings'); break;
    case 'open-logs': await act('/api/app/logs'); break;
    case 'audio-allow': {
      if (draft.audioDevices?.microphone === 'denied') { post({ cmd: 'open_url', url: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone' }); break; }
      const r = await act('/api/audio/permission');
      if (r) { draft.audioDevices = { ...draft.audioDevices, microphone: r.microphone }; renderSettings(); }
      break;
    }
    case 'kortix-connect':
      draft.syncError = ''; draft.syncErrorAdv = draft.dest !== (syncData?.view?.destination || 'off');
      if (await act('/api/kortix/connect', { issuer: draft.issuer.trim() }, true)) refreshLive();
      else { draft.syncError = actError; paintSync(); }
      break;
    case 'kortix-other': draft.otherIssuer = true; paintSync(); break;
    case 'kortix-approve': post({ cmd: 'open_url', url: syncData.jobs.connect?.progress?.approve_url }); break;
    case 'kortix-signout': draft.confirmOff = 'signout'; paintSync(); break;
    case 'sync-keep': draft.confirmOff = null; paintSync(); break;
    case 'sync-cancel': draft.dest = syncData?.view?.destination || 'off'; draft.syncError = ''; draft.s3 = null; paintSync(); break;
    case 'sync-stop': {
      const signout = draft.confirmOff === 'signout';
      draft.confirmOff = null;
      if (await act(signout ? '/api/app/signout' : '/api/sync/off')) {
        toast(signout ? 'Signed out. Sync is off and recording continues.' : 'Sync is off. Recordings stay on this ' + PC + '.');
        draft.dest = null; draft.syncError = '';
        await loadSettings();
      } else paintSync();
      break;
    }
    case 's3-save': {
      const f = s3Draft();
      const bad = s3Check(f, !!syncData.credentials?.saved);
      draft.syncErrorAdv = true;
      if (bad) { draft.syncError = bad; paintSync(); break; }
      draft.syncError = ''; draft.busy = 's3'; paintSync();
      const sameEndpoint = (settingsData.settings.sync?.s3?.endpoint || '') === f.endpoint.trim();
      const r = await act('/api/sync/setup', { provider: 's3', endpoint: f.endpoint, bucket: f.bucket, region: f.region, prefix: f.prefix,
        path_style: sameEndpoint && settingsData.settings.sync.s3.path_style ? true : guessPathStyle(f.endpoint),
        access_key_id: f.access_key_id, secret_access_key: f.secret_access_key }, true);
      draft.busy = '';
      if (r) { toast('Sync is on'); draft.s3 = null; draft.dest = null; await loadSettings(); }
      else { draft.syncError = actError; paintSync(); }
      break;
    }
    case 'forget-preview': {
      const tr = forgetRange($('#forget-from').value, $('#forget-to').value);
      if (!tr) { toast('Pick a start before the end'); break; }
      const r = await act('/api/storage/forget', { tr });
      if (r) { draft.forget = { from: $('#forget-from').value, to: $('#forget-to').value, tr, report: r }; renderSettings(); }
      break;
    }
    case 'forget-yes': {
      const r = await act('/api/storage/forget', { tr: draft.forget.tr, yes: true });
      if (r) { draft.forget = { ...draft.forget, report: r }; toast('Deleted'); invalidateSegments(); refreshBounds(); renderSettings(); }
      break;
    }
  }
});

/* ---------- keyboard ---------- */
window.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName);
  const mod = e.metaKey || e.ctrlKey;
  // The window is an accessory app with no Edit menu: edit keys work by hand in text fields.
  if (mod && typing && e.target.select !== undefined) {
    const el = e.target, k = e.key.toLowerCase();
    const sel = () => String(el.value || '').slice(el.selectionStart, el.selectionEnd);
    if (k === 'a') { e.preventDefault(); el.select(); return; }
    if (k === 'c' && sel()) { e.preventDefault(); post({ cmd: 'copy_text', text: sel() }); return; }
    if (k === 'x' && sel()) { e.preventDefault(); post({ cmd: 'copy_text', text: sel() }); el.setRangeText('', el.selectionStart, el.selectionEnd, 'end'); el.dispatchEvent(new Event('input', { bubbles: true })); return; }
    if (k === 'v') { e.preventDefault(); post({ cmd: 'paste' }); return; }
  }
  if (mod && e.key.toLowerCase() === 'c') {
    const sel = String(window.getSelection() || '');
    if (sel && !typing) { post({ cmd: 'copy_text', text: sel }); toast('Text copied'); e.preventDefault(); }
    return;
  }
  if (mod && e.key.toLowerCase() === 'f') { e.preventDefault(); openSearch(); return; }
  if (mod && e.key === ',') { e.preventDefault(); openSettings(); return; }
  if (mod && e.key.toLowerCase() === 'w') { e.preventDefault(); post({ cmd: 'close' }); return; }
  if (mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); zoom(1 / 1.6); return; }
  if (mod && e.key === '-') { e.preventDefault(); zoom(1.6); return; }
  if (e.key === 'Escape') {
    if (pop) closePop();
    else if (panelOpen()) closePanels();
    else if (window.getSelection().toString()) window.getSelection().removeAllRanges();
    else post({ cmd: 'close' });
    return;
  }
  if (typing) return;
  if (mod && !e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    if (panelOpen()) return;
    e.preventDefault();
    runJump(e.key === 'ArrowLeft' ? -1 : 1, true); // keyboard-initiated: no animation
    return;
  }
  if (mod) return;
  if (panelOpen()) return;
  switch (e.key) {
    case '/': e.preventDefault(); openSearch(); break;
    case 'ArrowLeft': e.preventDefault(); step(-1, e.shiftKey); break;
    case 'ArrowRight': e.preventDefault(); step(1, e.shiftKey); break;
    case '+': case '=': zoom(1 / 1.6); break;
    case '-': zoom(1.6); break;
    case 'n': case 'N': if (S.bounds.count) panTo(S.bounds.last_ms, true); break;
    case ' ': e.preventDefault(); setPlaying(!S.playing); break;
    case 'm': case 'M': setMuted(!S.muted); break;
  }
});

/* ---------- navigation from deep links / second launches ---------- */
async function navigate(t) {
  if (!t) return;
  if (t.view === 'search') { openSearch(t.q || ''); return; }
  if (t.view === 'settings') { openSettings(t.sync, t.section); return; }
  closePanels();
  if (t.q) S.terms = termsOf(t.q);
  await refreshBounds();
  if (!S.bounds.count) return;
  stopMomentum();
  cancelAnimationFrame(panRaf);
  const pos = initialPosition(S.bounds, t.t);
  if (pos.follow) { setT(pos.t, { follow: true }); await syncFrame(); return; }
  const r = await api('/api/nearest?t=' + Math.round(pos.t));
  S.follow = false;
  S.T = pos.t;
  drawTrack();
  if (r.id != null) await showFrame(r.id);
  updateClock();
  drawTrack();
}
window.kmemNavigate = navigate;
window.kmemPaste = (text) => {
  const el = document.activeElement;
  if (el && el.setRangeText && typeof el.selectionStart === 'number') {
    el.setRangeText(String(text), el.selectionStart, el.selectionEnd, 'end');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
};

/* ---------- boot ---------- */
new ResizeObserver(() => { fitStage(); resizeTrack(); }).observe(document.body);
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', drawTrack);
window.addEventListener('resize', () => { fitStage(); resizeTrack(); });

(async function boot() {
  let target = { view: 'timeline' };
  try { if (location.hash.length > 1) target = JSON.parse(decodeURIComponent(location.hash.slice(1))); } catch (_) {}
  history.replaceState(null, '', location.pathname);
  resizeTrack();
  try { appData = await api('/api/app'); } catch (e) { console.error(e); }
  if (appData && appData.onboarding) showOnboarding(true);
  paintChip();
  setInterval(refreshApp, 5000);
  await refreshBounds();
  // About 12 minutes across the track.
  S.spp = clamp(12 * 60000 / Math.max(400, trackW), SPP_MIN, SPP_MAX);
  if (S.bounds.count && target.t == null && target.view !== 'search' && target.view !== 'settings') {
    // Newest frame at the playhead. Widen the view when the default one would be almost empty.
    try {
      const last = S.bounds.last_ms, pad = Math.max(S.bounds.interval_ms || 2000, 2000);
      const r = await api(`/api/segments?from=${Math.floor(last - 6 * 3600000)}&to=${last}`);
      S.spp = openingSpp(S.bounds, r.segments, trackW, pad).spp;
    } catch (e) { console.error(e); }
  }
  if (S.bounds.count) {
    const view = target.view === 'search' || target.view === 'settings' ? { view: 'timeline' } : target;
    await navigate(view); // sets the position once: newest frame, or the requested time
  }
  S.ready = true;
  S.readyAt = performance.now();
  if (target.view === 'search' || target.view === 'settings') await navigate(target);
  setInterval(refreshBounds, 5000);
})();
