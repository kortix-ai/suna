// Pure-function checks for the timeline track. Run: node ui/memory/timeline.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const cut = (a, b) => src.slice(src.indexOf(a), src.indexOf(b));
const { segCovers, foldRuns, layoutRuns, runColor, runColors, rgbToHsl, brighter, placeIcons, initialPosition, runJumpTarget, acceptWheel, fmtRecorded, dayRows, openingSpp, gapHint, audioAt, audioBars, velocityFromSamples, momentumStep, MOMENTUM_TAU } = new Function(
  'const clamp = (v, a, b) => Math.max(a, Math.min(b, v));' + cut('function segCovers', 'async function ensureSegments') + cut('const VIVID_HUES', 'const TRACK_Y')
    + ';return {segCovers,foldRuns,layoutRuns,runColor,runColors,rgbToHsl,brighter,placeIcons,initialPosition,runJumpTarget,acceptWheel,fmtRecorded,dayRows,openingSpp,gapHint,audioAt,audioBars,velocityFromSamples,momentumStep,MOMENTUM_TAU}',
)();

const run = (s, e, id) => ({ s: s * 1000, e: e * 1000, app: { id }, domain: null });
const PAD = 2000;
const spp = 1000; // 1 s per px: 4 px = 4 s, so the 20 s rule dominates

// Rule 1: a 6 s interruption between two runs of the same app folds into one run.
let f = foldRuns([run(0, 100, 1), run(102, 108, 2), run(110, 200, 1)], spp, PAD);
assert.equal(f.length, 1);
assert.deepEqual([f[0].s, f[0].e, f[0].n], [0, 200000, 3]);

// A 60 s interruption stays: it is longer than 20 s.
f = foldRuns([run(0, 100, 1), run(102, 162, 2), run(164, 300, 1)], spp, PAD);
assert.equal(f.length, 3);

// An interruption between different apps does not fold under rule 1 (no sandwich), and a
// run longer than 4 px is not tiny, so rule 2 leaves it.
f = foldRuns([run(0, 100, 1), run(102, 108, 2), run(110, 200, 3)], spp, PAD);
assert.equal(f.length, 3);

// Rule 2: at far zoom (60 s per px, 4 px = 240 s) a 30 s run joins the longer neighbour.
f = foldRuns([run(0, 1000, 1), run(1002, 1030, 2), run(1032, 2000, 3)], 60000, PAD);
assert.equal(f.length, 2);
assert.equal(f[0].app.id, 1);
assert.deepEqual([f[0].s, f[0].e], [0, 1030000]);

// Idle gaps (> 60 s) never fold, even for the same app.
f = foldRuns([run(0, 100, 1), run(500, 600, 1)], spp, PAD);
assert.equal(f.length, 2);

// Raw input is untouched (the tooltip keeps reading it).
const raw = [run(0, 100, 1), run(102, 108, 2), run(110, 200, 1)];
foldRuns(raw, spp, PAD);
assert.equal(raw.length, 3);

// Layout: every run keeps 3 px, runs never overlap, a flush seam exists.
const xOf = (t) => t / 1000;
const L = layoutRuns([run(0, 0.2, 1), run(2, 100, 2), run(102, 200, 3)], xOf, 1000, PAD);
assert.ok(L.every((r) => r.w >= 1.5));
for (let i = 1; i < L.length; i++) assert.ok(L[i].x >= L[i - 1].x + L[i - 1].w - 1e-9 || L[i].w <= 3);

// Segment cache coverage: refetch when the window nears the edge of the cached range.
assert.equal(segCovers([0, 300], 100, 200), true);
assert.equal(segCovers([0, 300], 10, 110), false);
assert.equal(segCovers([0, 0], 0, 10), false);
// Color: every run lands in the vivid pastel band (S 45-70 %, L 55-68 % on the dark dock).
const red = 0xff0000, blue = 0x0000ff;
const hueDiff = (a, b) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));
const inBand = (rgb) => { const [, s, l] = rgbToHsl(rgb); return s >= 0.44 && s <= 0.71 && l >= 0.54 && l <= 0.69; };
const dom = runColor({ app: { id: 1, color: blue }, domain: { id: 2, color: red } }, true);
assert.ok(inBand(dom) && hueDiff(rgbToHsl(dom)[0], 0) < 6, 'the domain hue wins for browser runs');
const appc = runColor({ app: { id: 1, color: blue }, domain: { id: 2, color: null } }, true);
assert.ok(inBand(appc) && hueDiff(rgbToHsl(appc)[0], 240) < 6, 'a domain without a color falls back to the app hue');
assert.ok(hueDiff(rgbToHsl(runColor({ app: { id: 1, color: blue }, domain: null }, true))[0], 240) < 6);
for (const stored of [0x000000, 0xffffff, 0x808080, 0x1a1a1a, 0xf4f4f4, 0x123456, null]) {
  const c = runColor({ k: 'a7', app: { id: 7, color: stored } }, true);
  assert.ok(inBand(c), `stored ${stored} is normalized into the band: ${c}`);
}
// Grey and black have no hue: the hue comes from the key, stable across calls and different across keys.
const g1 = runColor({ k: 'a7', app: { id: 7, color: 0x808080 } }, true), g2 = runColor({ k: 'a7', app: { id: 7, color: 0x808080 } }, true);
assert.deepEqual(g1, g2);
const hues = new Set(['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8'].map((k) => Math.round(rgbToHsl(runColor({ k, app: { id: 1 } }, true))[0])));
assert.ok(hues.size >= 4, 'hashed hues spread over the palette');
assert.ok(inBand(runColor({ app: { id: 1, color: 0x000000 } }, true)), 'a black app is visible on the dark dock');
// Neighbours with different keys never share a hue; the same key keeps its color.
const lr = (k, color) => ({ s: { k, app: { id: k, color }, domain: null } });
const same = runColors([lr('a1', 0x2bb5a0), lr('a2', 0x2cb6a1), lr('a3', 0x2bb4a2)], true);
for (let i = 1; i < same.length; i++) assert.ok(hueDiff(rgbToHsl(same[i])[0], rgbToHsl(same[i - 1])[0]) >= 22, 'adjacent distinct keys differ');
const keep = runColors([lr('a1', 0x2bb5a0), lr('a1', 0x2bb5a0)], true);
assert.deepEqual(keep[0], keep[1]);
// The run under the playhead is brighter, same hue.
const base = runColor({ k: 'a1', app: { id: 1, color: 0x2bb5a0 } }, true), br = brighter(base);
assert.ok(rgbToHsl(br)[2] > rgbToHsl(base)[2] + 0.08 && hueDiff(rgbToHsl(br)[0], rgbToHsl(base)[0]) < 4);

// Icons: the favicon for domains, never closer than size + space, sticky at the left edge.
const iconRun = (x, w, extra = {}) => ({ x, w, s: { app: { id: 1, icon: true }, domain: null, ...extra } });
let ic = placeIcons([iconRun(100, 200), iconRun(110, 200), iconRun(140, 200), iconRun(200, 50)], 1000);
const xs = ic.map((i) => i.cx);
for (let i = 1; i < xs.length; i++) assert.ok(xs[i] - xs[i - 1] >= 30, 'icons never overlap (22 px badge + 8 px space)');
assert.equal(ic.length >= 2, true);
assert.equal(placeIcons([iconRun(100, 10)], 1000).length, 0, 'a run under 18 px gets no icon');
assert.equal(placeIcons([{ x: 100, w: 200, s: { app: { id: 1, icon: false }, domain: null } }], 1000).length, 0, 'no icon file, no badge');
ic = placeIcons([iconRun(-300, 600)], 1000);
assert.equal(ic.length, 1);
assert.ok(ic[0].cx >= 12 && ic[0].cx <= 14, 'a run scrolled partly off keeps its icon at the left edge');
ic = placeIcons([iconRun(-300, 20)], 1000);
assert.equal(ic.length, 0, 'a run almost fully off screen has no room for its icon');
ic = placeIcons([iconRun(100, 200, { domain: { id: 3, icon: true } })], 1000);
assert.equal(ic.length, 1);

// Momentum: release velocity, decay, and distance.
const T0 = 1000;
assert.equal(velocityFromSamples([{ t: T0, x: 0 }]), 0);
assert.equal(velocityFromSamples([{ t: T0, x: 0 }, { t: T0 + 50, x: 100 }]), 2);
// Only the last 100 ms count: an early fast phase does not leak into a slow release.
assert.equal(velocityFromSamples([{ t: T0, x: 0 }, { t: T0 + 10, x: 500 }, { t: T0 + 200, x: 510 }, { t: T0 + 300, x: 520 }]), 0.1);
const one = momentumStep(2, 100);
const half = momentumStep(2, 50), half2 = momentumStep(half.v, 50);
assert.ok(Math.abs(one.dx - (half.dx + half2.dx)) < 1e-9, 'steps compose: frame rate does not change the distance');
assert.ok(Math.abs(one.v - half2.v) < 1e-9);
assert.ok(Math.abs(momentumStep(2, 1e9).dx - 2 * MOMENTUM_TAU) < 1e-6, 'total travel = v * tau');
assert.ok(momentumStep(-2, 100).dx < 0 && momentumStep(-2, 100).v > -2);
// Initial position: newest frame and follow, unless a time is requested.
const B = { count: 10, first_ms: 1000, last_ms: 9000 };
assert.deepEqual(initialPosition(B, undefined), { t: 9000, follow: true });
assert.deepEqual(initialPosition(B, null), { t: 9000, follow: true });
assert.deepEqual(initialPosition(B, 4000), { t: 4000, follow: false });
assert.deepEqual(initialPosition(B, 99999), { t: 9000, follow: false }, 'a requested time past the end clamps to the newest frame');
assert.deepEqual(initialPosition(B, -5), { t: 1000, follow: false });
assert.deepEqual(initialPosition(B, NaN), { t: 9000, follow: true });
assert.deepEqual(initialPosition({ count: 0 }, 4000), { t: null, follow: true });

// Run jumps over folded runs: [0-100 s app1] [200-300 s app2] [400-500 s app1], pad 2 s.
const jr = (s, e, k) => ({ s: s * 1000, e: e * 1000, k });
const RJ = [jr(0, 100, 'a1'), jr(200, 300, 'a2'), jr(400, 500, 'a1')];
const jt = (sec, dir) => runJumpTarget(RJ, sec * 1000, dir, 2000);
assert.equal(jt(250, -1), 200000, 'inside a run, Left goes to its start first');
assert.equal(jt(200, -1), 0, 'at a run start, Left goes to the previous run');
assert.equal(jt(200.5, -1), 0, 'within 1 s of the start counts as at the start');
assert.equal(jt(0, -1), null, 'at the first run start there is nowhere to go left');
assert.equal(jt(50, -1), 0);
assert.equal(jt(250, 1), 400000);
assert.equal(jt(450, 1), null, 'inside the last run, Right has no next run');
assert.equal(jt(0, 1), 200000);
assert.equal(jt(150, -1), 0, 'in an idle gap, Left goes to the start of the run before it');
assert.equal(jt(150, 1), 200000, 'in an idle gap, Right goes to the next run start');
assert.equal(jt(600, -1), 400000, 'after the last run, Left goes to its start');
assert.equal(runJumpTarget([], 5, 1, 2000), null);
// Folded slivers: a 6 s interruption inside app1 folds away, so a jump never lands on it.
const folded = foldRuns([run(0, 100, 1), run(102, 108, 2), run(110, 200, 1), run(300, 400, 3)], 1000, 2000);
assert.equal(runJumpTarget(folded, 150000, -1, 2000), 0, 'Left from inside the merged run goes to its start, not the sliver');
assert.equal(runJumpTarget(folded, 150000, 1, 2000), 300000, 'Right skips the folded sliver');
// Stray wheel input: the tail of an earlier gesture never moves a freshly opened window.
const W0 = () => ({ carry: false, last: 0, prev: null });
const feed = (st, times, readyAt, present) => times.map((t) => acceptWheel(st, t, readyAt, present));
// A momentum tail at 16 ms spacing that starts before the window is ready and runs 3 s: all dropped.
let st = W0();
const tail = Array.from({ length: 190 }, (_, i) => 500 + i * 16);
assert.ok(feed(st, tail, 1000, false).every((v) => v === false), 'momentum tail dropped, no presence');
assert.ok(feed(W0(), tail, 1000, true).every((v) => v === false), 'momentum tail dropped even when the pointer has moved');
// A tail that starts after the grace period, with no presence, is dropped.
st = W0();
assert.ok(feed(st, Array.from({ length: 60 }, (_, i) => 2700 + i * 16), 1000, false).every((v) => v === false), 'a late tail without presence is dropped');
// Presence plus a new gesture after a pause is accepted once the burst is over.
st = W0();
feed(st, tail, 1000, true);
assert.equal(acceptWheel(st, 4100, 1000, true), true, 'a new gesture after a pause, with presence');
assert.equal(acceptWheel(st, 4116, 1000, true), true);
// Without presence, a deliberate gesture long after opening is accepted.
st = W0();
assert.equal(acceptWheel(st, 9000, 1000, false), true, 'a gesture 8 s after opening, after a pause, no presence');
assert.equal(acceptWheel(st, 9016, 1000, false), true, 'and it continues');
// Without presence, 2 s after opening is too early.
st = W0();
assert.equal(acceptWheel(st, 3000, 1000, false), false, '2 s after opening with no presence');
// A clean gesture with presence, after the grace period, is accepted.
st = W0();
assert.equal(acceptWheel(st, 5000, 1000, true), true);
// Before the window is ready (readyAt = Infinity) nothing is accepted and a burst is marked.
st = W0();
assert.equal(acceptWheel(st, 100, Infinity, true), false);
// A new gesture right after a stalled burst (gap under `quiet`) is not accepted even with presence.
st = W0();
feed(st, tail, 1000, true);
assert.equal(acceptWheel(st, 3524 + 200, 1000, true), false, '200 ms after the tail is still the tail');
assert.equal(acceptWheel(st, 3524 + 1000, 1000, true), true, 'a gesture after a 776 ms pause');
// Opening zoom. Track 1200 px: the default view is 12 min, so 600 ms per px.
const MIN = 60000, PADMS = 2000, HR = 3600000;
const NOW = 100 * HR;
const run2 = (fromMin, toMin) => ({ s: NOW - fromMin * MIN, e: NOW - toMin * MIN });
const B2 = { count: 500, first_ms: NOW - 20 * HR, last_ms: NOW };
// Normal case: recording right up to now, the default view is mostly recorded.
let o = openingSpp(B2, [run2(40, 0)], 1200, PADMS);
assert.deepEqual([o.spp, o.widened], [600, false]);
// Empty library: the default zoom, no widening, no crash.
assert.deepEqual(openingSpp({ count: 0 }, [], 1200, PADMS), { spp: 600, widened: false });
assert.deepEqual(openingSpp(B2, [], 1200, PADMS), { spp: 600, widened: false }, 'no runs loaded');
// Gap case: a 55 min gap, then 30 s of new recording. The previous recording ended 56 min ago.
o = openingSpp(B2, [run2(120, 56), run2(0.5, 0)], 1200, PADMS);
assert.equal(o.widened, true);
const halfSpan = (o.spp * 1200) / 2;
assert.ok(halfSpan >= 56 * MIN, 'the left half reaches the end of the previous recording');
assert.ok(halfSpan <= 56 * MIN * 1.2, 'and does not overshoot by much');
// Recorded fraction just under and over 15 % of the left half (6 min): 0.8 min vs 1.2 min.
assert.equal(openingSpp(B2, [run2(120, 56), run2(0.8, 0)], 1200, PADMS).widened, true);
assert.equal(openingSpp(B2, [run2(120, 56), run2(1.2, 0)], 1200, PADMS).widened, false);
// The cap: the previous recording ended 20 h ago, the view stops at 6 h across.
o = openingSpp(B2, [run2(1500, 1200), run2(0.5, 0)], 1200, PADMS);
assert.equal(o.widened, true);
assert.ok(Math.abs(o.spp * 1200 - 6 * HR) < 1, 'capped at 6 hours across');
// No earlier recording at all: nothing to widen toward.
assert.equal(openingSpp(B2, [run2(1, 0)], 1200, PADMS).widened, false);
// Zoom limits hold.
assert.ok(openingSpp(B2, [run2(1500, 1200), run2(0.5, 0)], 1200, PADMS, { maxSpp: 5000 }).spp <= 5000);

// Idle-gap hint: shown only inside a long gap between two runs.
const gs = [run2(120, 100), run2(30, 0)];
const at = (minAgo) => NOW - minAgo * MIN;
assert.equal(gapHint(gs, at(110), PADMS, '⌘'), null, 'inside a run');
const gh = gapHint(gs, at(60), PADMS, '⌘');
assert.ok(gh && gh.text === 'No recording here. Press ⌘← to jump back.');
assert.equal(gh.start, gs[0].e + PADMS);
assert.equal(gh.end, gs[1].s);
assert.equal(gapHint([run2(120, 100), run2(97, 0)], at(99), PADMS, '⌘'), null, 'a gap under 5 minutes shows no hint');
assert.equal(gapHint(gs, at(15), PADMS, '⌘'), null, 'inside the second run');
assert.equal(gapHint(gs, at(130), PADMS, '⌘'), null, 'before the first run: no gap between two runs');
assert.equal(gapHint([], at(5), PADMS, '⌘'), null);
assert.match(gapHint(gs, at(60), PADMS, 'Ctrl+').text, /Press Ctrl\+← to jump back\./);

// Jump popover: one row per recorded day, newest first, targeting the day's last frame.
{
  const at = (y, m, d, h = 12, min = 0) => new Date(y, m - 1, d, h, min).getTime();
  const day = (date, last, frames, recorded) => ({ date, first_ms: last - recorded, last_ms: last, frames, recorded_ms: recorded });
  const now = at(2026, 10, 3, 0, 31);
  const days = [
    day('2026-10-03', at(2026, 10, 3, 0, 30), 900, 30 * 60000),
    day('2026-10-02', at(2026, 10, 2, 23, 59), 6000, (3 * 60 + 12) * 60000),
    day('2026-09-30', at(2026, 9, 30, 18, 5), 1, 0),
    day('2025-12-31', at(2025, 12, 31, 9), 40, 59000),
  ];
  const fmt = (d) => `D${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  const rows = dayRows(days, now, at(2026, 10, 2, 15), fmt);
  assert.deepEqual(rows.map((r) => r.label), ['Today', 'Yesterday', 'D2026-9-30', 'D2025-12-31']);
  assert.deepEqual(rows.map((r) => r.sub), ['30 m', '3 h 12 m', '1 frame', '40 frames']);
  assert.deepEqual(rows.map((r) => r.target), days.map((d) => d.last_ms), 'a click lands on the last frame, not midnight');
  assert.deepEqual(rows.map((r) => r.current), [false, true, false, false], 'the playhead day is marked');
  // Yesterday across a month boundary; no playhead marks nothing; no days lists nothing.
  assert.equal(dayRows([day('2026-09-30', at(2026, 9, 30), 5, 120000)], at(2026, 10, 1, 8), null, fmt)[0].label, 'Yesterday');
  assert.equal(dayRows([day('2026-09-30', at(2026, 9, 30), 5, 120000)], at(2026, 10, 1, 8), null, fmt)[0].current, false);
  assert.deepEqual(dayRows([], now, now, fmt), []);
  assert.equal(fmtRecorded(60 * 60000, 1800), '1 h 0 m');
}
console.log('timeline checks passed');

// Audio: the segment under the playhead and the offset into it.
{
  const segs = [{ id: 1, s: 60_000, e: 120_000 }, { id: 2, s: 120_000, e: 150_000 }, { id: 3, s: 400_000, e: 460_000 }];
  assert.deepEqual(audioAt(segs, 90_000), { seg: segs[0], offset: 30 });
  assert.equal(audioAt(segs, 120_000).seg.id, 2, 'a boundary belongs to the next segment');
  assert.equal(audioAt(segs, 200_000), null, 'a gap plays nothing');
  assert.equal(audioAt([], 1), null);
  // Indicator bars: adjacent segments merge into one quiet line, a gap splits it, off-screen ones drop.
  const bars = audioBars(segs, (t) => t / 1000, 300);
  assert.deepEqual(bars, [{ x: 60, w: 90 }]);
  const wide = audioBars(segs, (t) => t / 1000, 1000);
  assert.equal(wide.length, 2);
  assert.deepEqual(wide[1], { x: 400, w: 60 });
  assert.ok(audioBars(segs, (t) => t / 1e6, 1000).every((b) => b.w >= 1), 'every bar is at least 1 px');
}
console.log('timeline audio checks passed');
