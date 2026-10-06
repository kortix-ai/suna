// Ported from kortix-ai/capture apps/recorder/ui/memory/timeline.test.mjs: the web track
// must fold, lay out, color, jump and glide exactly like the desktop one.
import { describe, expect, test } from 'bun:test';
import {
  audioBars,
  brighter,
  foldRuns,
  gapAt,
  layoutRuns,
  MOMENTUM_TAU,
  momentumStep,
  openingSpp,
  placeIcons,
  rgbToHsl,
  runColor,
  runColors,
  runJumpTarget,
  segCovers,
  velocityFromSamples,
  type TrackRun,
} from './track-model';

const run = (s: number, e: number, k: string): TrackRun => ({
  s: s * 1000,
  e: e * 1000,
  k,
  app: k,
  title: null,
  url: null,
});
const PAD = 2000;
const hueDiff = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));

describe('folding', () => {
  test('a 6 s interruption between two runs of the same app folds into one run; 60 s stays', () => {
    const f = foldRuns([run(0, 100, 'a'), run(102, 108, 'b'), run(110, 200, 'a')], 1000, PAD);
    expect(f.map((r) => [r.s, r.e, r.n])).toEqual([[0, 200_000, 3]]);
    expect(
      foldRuns([run(0, 100, 'a'), run(102, 162, 'b'), run(164, 300, 'a')], 1000, PAD),
    ).toHaveLength(3);
  });

  test('different apps do not sandwich-fold; at far zoom a tiny run joins the longer neighbour', () => {
    expect(
      foldRuns([run(0, 100, 'a'), run(102, 108, 'b'), run(110, 200, 'c')], 1000, PAD),
    ).toHaveLength(3);
    const f = foldRuns(
      [run(0, 1000, 'a'), run(1002, 1030, 'b'), run(1032, 2000, 'c')],
      60_000,
      PAD,
    );
    expect(f).toHaveLength(2);
    expect([f[0]!.k, f[0]!.s, f[0]!.e]).toEqual(['a', 0, 1_030_000]);
  });

  test('idle gaps over 60 s never fold; the input is untouched', () => {
    expect(foldRuns([run(0, 100, 'a'), run(500, 600, 'a')], 1000, PAD)).toHaveLength(2);
    const raw = [run(0, 100, 'a'), run(102, 108, 'b'), run(110, 200, 'a')];
    foldRuns(raw, 1000, PAD);
    expect(raw).toHaveLength(3);
  });
});

describe('layout and icons', () => {
  test('every run keeps its minimum width and runs never overlap', () => {
    const L = layoutRuns(
      [run(0, 0.2, 'a'), run(2, 100, 'b'), run(102, 200, 'c')],
      (t) => t / 1000,
      1000,
      PAD,
    );
    expect(L.every((r) => r.w >= 1.5)).toBe(true);
    for (let i = 1; i < L.length; i++)
      expect(L[i]!.x >= L[i - 1]!.x + L[i - 1]!.w - 1e-9 || L[i]!.w <= 3).toBe(true);
  });

  test('icons never overlap, a short run has none, a run scrolled partly off keeps its icon at the left edge', () => {
    const laid = (x: number, w: number, app: string | null = 'a') => ({
      x,
      w,
      s: { ...run(0, 1, 'a'), app },
    });
    const xs = placeIcons(
      [laid(100, 200), laid(110, 200), laid(140, 200), laid(200, 50)],
      1000,
    ).map((i) => i.cx);
    for (let i = 1; i < xs.length; i++) expect(xs[i]! - xs[i - 1]!).toBeGreaterThanOrEqual(30);
    expect(placeIcons([laid(100, 10)], 1000)).toHaveLength(0);
    expect(placeIcons([laid(100, 200, null)], 1000)).toHaveLength(0);
    const edge = placeIcons([laid(-300, 600)], 1000);
    expect(edge[0]!.cx).toBeGreaterThanOrEqual(12);
    expect(edge[0]!.cx).toBeLessThanOrEqual(14);
  });

  test('cache coverage refetches near the edge of the cached range', () => {
    expect(segCovers([0, 300], 100, 200)).toBe(true);
    expect(segCovers([0, 300], 10, 110)).toBe(false);
    expect(segCovers([0, 0], 0, 10)).toBe(false);
  });
});

describe('colors', () => {
  const inBand = (rgb: [number, number, number]) => {
    const [, s, l] = rgbToHsl(rgb);
    return s >= 0.44 && s <= 0.71 && l >= 0.54 && l <= 0.69;
  };
  test('a stable vivid hue per app, spread across apps; neighbours differ; the playhead run is brighter', () => {
    expect(runColor({ k: 'Mail', app: 'Mail' }, true)).toEqual(
      runColor({ k: 'Mail', app: 'Mail' }, true),
    );
    expect(inBand(runColor({ k: 'Mail', app: 'Mail' }, true))).toBe(true);
    const hues = new Set(
      ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8'].map((k) =>
        Math.round(rgbToHsl(runColor({ k, app: k }, true))[0]),
      ),
    );
    expect(hues.size).toBeGreaterThanOrEqual(4);
    const cols = runColors(
      ['x1', 'x2', 'x3', 'x4'].map((k) => ({ s: { k, app: k } })),
      true,
    );
    for (let i = 1; i < cols.length; i++)
      expect(hueDiff(rgbToHsl(cols[i]!)[0], rgbToHsl(cols[i - 1]!)[0])).toBeGreaterThanOrEqual(22);
    const base = runColor({ k: 'a1', app: 'a1' }, true);
    expect(rgbToHsl(brighter(base))[2]).toBeGreaterThan(rgbToHsl(base)[2] + 0.08);
  });
});

describe('navigation', () => {
  const RJ = [run(0, 100, 'a'), run(200, 300, 'b'), run(400, 500, 'a')];
  const jt = (sec: number, dir: -1 | 1) => runJumpTarget(RJ, sec * 1000, dir, PAD);
  test('Cmd/Ctrl+Left goes to the run start first, then the previous run; Right goes to the next run', () => {
    expect(jt(250, -1)).toBe(200_000);
    expect(jt(200, -1)).toBe(0);
    expect(jt(200.5, -1)).toBe(0);
    expect(jt(0, -1)).toBeNull();
    expect(jt(250, 1)).toBe(400_000);
    expect(jt(450, 1)).toBeNull();
    expect(jt(150, -1)).toBe(0);
    expect(jt(150, 1)).toBe(200_000);
    expect(jt(600, -1)).toBe(400_000);
    expect(runJumpTarget([], 5, 1, PAD)).toBeNull();
  });

  test('the gap hint shows only inside a gap of 5 minutes or more between two runs', () => {
    const MIN = 60_000;
    const NOW = 100 * 3_600_000;
    const r2 = (fromMin: number, toMin: number): TrackRun => ({
      ...run(0, 1, 'a'),
      s: NOW - fromMin * MIN,
      e: NOW - toMin * MIN,
    });
    const gs = [r2(120, 100), r2(30, 0)];
    const at = (m: number) => NOW - m * MIN;
    expect(gapAt(gs, at(110), PAD)).toBeNull();
    expect(gapAt(gs, at(60), PAD)).toEqual({ start: gs[0]!.e + PAD, end: gs[1]!.s });
    expect(gapAt([r2(120, 100), r2(97, 0)], at(99), PAD)).toBeNull();
    expect(gapAt(gs, at(130), PAD)).toBeNull();
    expect(gapAt([], at(5), PAD)).toBeNull();
  });

  test('audio bars merge adjacent segments, split on gaps, and keep 1 px', () => {
    const segs = [
      { s: 60_000, e: 120_000 },
      { s: 120_000, e: 150_000 },
      { s: 400_000, e: 460_000 },
    ];
    expect(audioBars(segs, (t) => t / 1000, 300)).toEqual([{ x: 60, w: 90 }]);
    expect(audioBars(segs, (t) => t / 1000, 1000)).toHaveLength(2);
    expect(audioBars(segs, (t) => t / 1e6, 1000).every((b) => b.w >= 1)).toBe(true);
  });
});

describe('inertia and opening zoom', () => {
  test('release velocity uses the last 100 ms; steps compose; total travel is v × tau', () => {
    expect(velocityFromSamples([{ t: 1000, x: 0 }])).toBe(0);
    expect(
      velocityFromSamples([
        { t: 1000, x: 0 },
        { t: 1050, x: 100 },
      ]),
    ).toBe(2);
    expect(
      velocityFromSamples([
        { t: 1000, x: 0 },
        { t: 1010, x: 500 },
        { t: 1200, x: 510 },
        { t: 1300, x: 520 },
      ]),
    ).toBe(0.1);
    const one = momentumStep(2, 100);
    const half = momentumStep(2, 50);
    const half2 = momentumStep(half.v, 50);
    expect(Math.abs(one.dx - (half.dx + half2.dx))).toBeLessThan(1e-9);
    expect(Math.abs(momentumStep(2, 1e9).dx - 2 * MOMENTUM_TAU)).toBeLessThan(1e-6);
  });

  test('12 minutes across by default; widened to reach the previous recording after a long gap; capped at 6 h', () => {
    const MIN = 60_000;
    const HR = 3_600_000;
    const NOW = 100 * HR;
    const r2 = (fromMin: number, toMin: number): TrackRun => ({
      ...run(0, 1, 'a'),
      s: NOW - fromMin * MIN,
      e: NOW - toMin * MIN,
    });
    expect(openingSpp(NOW, [r2(40, 0)], 1200, PAD)).toEqual({ spp: 600, widened: false });
    expect(openingSpp(null, [], 1200, PAD)).toEqual({ spp: 600, widened: false });
    const o = openingSpp(NOW, [r2(120, 56), r2(0.5, 0)], 1200, PAD);
    expect(o.widened).toBe(true);
    expect((o.spp * 1200) / 2).toBeGreaterThanOrEqual(56 * MIN);
    expect((o.spp * 1200) / 2).toBeLessThanOrEqual(56 * MIN * 1.2);
    expect(
      Math.abs(openingSpp(NOW, [r2(1500, 1200), r2(0.5, 0)], 1200, PAD).spp * 1200 - 6 * HR),
    ).toBeLessThan(1);
    expect(openingSpp(NOW, [r2(1, 0)], 1200, PAD).widened).toBe(false);
  });
});
