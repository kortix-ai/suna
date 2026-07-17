/**
 * KortixCurrents — the mobile port of the web `mark-effects/kortix-currents`.
 *
 * Ambient currents flow across the whole frame. The Kortix mark is NEVER drawn:
 * no outline, no stroke, no fill. Particles are seeded along the mark's outline
 * and glow in Kortix orange as they drift off it, so the logo forms out of the
 * glow alone and fades where the flow has moved on. Eases in over ~1.8s.
 *
 * Rendering notes (these differ from web, which has a real 2D canvas):
 *  - Web accumulates motion trails by painting a translucent fade rect over the
 *    previous frame. Skia's <Canvas> is immediate-mode with no persistent
 *    backbuffer, so each particle instead draws a pre-rendered *streak* sprite
 *    rotated to its flow angle. Same read, one draw call.
 *  - Web rasterizes the symbol and samples its alpha to find the edge band.
 *    Here `ContourMeasureIter` walks the path outline directly, which is both
 *    exact and cheaper.
 *  - Everything is a single `drawAtlas`, so particle count costs a buffer write
 *    per frame rather than a draw call.
 */

import * as React from 'react';
import { AccessibilityInfo, View, type LayoutChangeEvent } from 'react-native';
import {
  Atlas,
  Canvas,
  Fill,
  PaintStyle,
  Skia,
  StrokeCap,
  TileMode,
  useClock,
  useRSXformBuffer,
  type SkImage,
  type SkRSXform,
  type SkRect,
} from '@shopify/react-native-skia';
import { useSharedValue } from 'react-native-reanimated';

import { KORTIX_SYMBOL_PATH, SYMBOL_ASPECT, SYMBOL_HEIGHT, clamp01, flowAngle } from '@/lib/effects/mark-math';

// ── Palette — mirrors the web effect ─────────────────────────────────────────
const INK = '#0A0A0A';
const AMBIENT = 'rgba(232,232,232,0.42)';
const AMBIENT_ORANGE = 'rgba(224,138,51,0.80)';
const GLOW_ORANGE = 'rgba(240,150,62,0.46)';
const GLOW_WHITE = 'rgba(255,255,255,0.38)';

// ── Simulation constants ─────────────────────────────────────────────────────
// COUNT is 1200 vs the web's 2400: each particle costs one JSI write into the
// RSXform buffer per frame, and 1200 holds 60fps on mid-tier devices.
const COUNT = 1200;
// More edge particles than web (0.42): each glow sprite is small, so the mark's
// outline needs more of them to read as a continuous glow rather than beads.
const EDGE_RATIO = 0.55;
const SPEED = 1.0;
const AMBIENT_ORANGE_RATIO = 0.14;
const GLOW_ORANGE_RATIO = 0.78;
const REVEAL_MS = 1800;
const TIME_SCALE = 4200;

/**
 * How far, in px, a glow particle drifts off the outline before it has fully
 * faded. Web tests each particle's *position* against a rasterized edge band,
 * so its glow is replenished by any particle wandering onto the mark. Here a
 * particle instead fades with distance from where it spawned — which only reads
 * the same if edge particles are short-lived enough to keep respawning on the
 * outline. Hence EDGE_LIFE below is derived from this, not chosen freely.
 */
const GLOW_DRIFT = 10;
const EDGE_LIFE_MIN = 2;
const EDGE_LIFE_RANGE = GLOW_DRIFT / SPEED;

/** Spacing, in px, between sampled points along the mark's outline. */
const EDGE_SPACING = 1.5;

// ── Sprite sheet — 4 cells of 32px: streaks (white/orange), glows (orange/white)
const CELL = 32;
const CELL_AMBIENT = 0;
const CELL_AMBIENT_ORANGE = 1;
const CELL_GLOW_ORANGE = 2;
const CELL_GLOW_WHITE = 3;

// Sprites are authored in a 32px cell; these scale them onto the screen.
// GLOW_SCALE lands the glow at ~8px, matching the web's GLOW_SIZE of 6.
const STREAK_SCALE = 0.65;
const GLOW_SCALE = 0.26;

type Particle = {
  x: number;
  y: number;
  /** Spawn point — edge particles fade as they drift away from it. */
  ox: number;
  oy: number;
  life: number;
  edge: boolean;
};

/**
 * Renders the 4 sprites once into a CPU surface. `Surface.Make` (not
 * `MakeOffscreen`) so this works before a GPU context exists.
 */
function makeSpriteSheet(): SkImage | null {
  const surface = Skia.Surface.Make(CELL * 4, CELL);
  if (!surface) return null;
  const canvas = surface.getCanvas();

  const drawStreak = (cell: number, color: string) => {
    const x0 = cell * CELL + 5;
    const x1 = cell * CELL + 27;
    const paint = Skia.Paint();
    paint.setAntiAlias(true);
    paint.setStyle(PaintStyle.Stroke);
    paint.setStrokeWidth(2.4);
    paint.setStrokeCap(StrokeCap.Round);
    // Comet: transparent at the tail, full colour at the head.
    paint.setShader(
      Skia.Shader.MakeLinearGradient(
        Skia.Point(x0, 0),
        Skia.Point(x1, 0),
        [Skia.Color('rgba(0,0,0,0)'), Skia.Color(color)],
        [0, 1],
        TileMode.Clamp
      )
    );
    const path = Skia.Path.Make();
    path.moveTo(x0, CELL / 2);
    path.lineTo(x1, CELL / 2);
    canvas.drawPath(path, paint);
  };

  const drawGlow = (cell: number, color: string) => {
    const cx = cell * CELL + CELL / 2;
    const paint = Skia.Paint();
    paint.setAntiAlias(true);
    paint.setShader(
      Skia.Shader.MakeRadialGradient(
        Skia.Point(cx, CELL / 2),
        CELL / 2,
        [Skia.Color(color), Skia.Color('rgba(0,0,0,0)')],
        [0, 1],
        TileMode.Clamp
      )
    );
    canvas.drawRect(Skia.XYWHRect(cell * CELL, 0, CELL, CELL), paint);
  };

  drawStreak(CELL_AMBIENT, AMBIENT);
  drawStreak(CELL_AMBIENT_ORANGE, AMBIENT_ORANGE);
  drawGlow(CELL_GLOW_ORANGE, GLOW_ORANGE);
  drawGlow(CELL_GLOW_WHITE, GLOW_WHITE);

  return surface.makeImageSnapshot();
}

/**
 * Points along the mark's outline, fitted to the frame. Walking the contours is
 * exact — no rasterize-and-threshold step like the web version needs.
 *
 * `markCenterY` is where the mark's centre sits as a fraction of the frame
 * height; the field itself always fills the frame.
 */
function buildEdgePoints(width: number, height: number, markCenterY: number): number[] {
  const path = Skia.Path.MakeFromSVGString(KORTIX_SYMBOL_PATH);
  if (!path) return [];

  const size = Math.min(height * 0.64, (width * 0.64) / SYMBOL_ASPECT);
  const scale = size / SYMBOL_HEIGHT;
  const w = size * SYMBOL_ASPECT;
  const h = size;

  const matrix = Skia.Matrix();
  matrix.translate((width - w) / 2, height * markCenterY - h / 2);
  matrix.scale(scale, scale);
  path.transform(matrix);

  const points: number[] = [];
  const iter = Skia.ContourMeasureIter(path, false, 1);
  let contour = iter.next();
  while (contour) {
    const length = contour.length();
    for (let d = 0; d < length; d += EDGE_SPACING) {
      const [pos] = contour.getPosTan(d);
      points.push(pos.x, pos.y);
    }
    contour = iter.next();
  }
  return points;
}

function seedParticles(width: number, height: number, edgePoints: number[]): Particle[] {
  const edgeCount = Math.round(COUNT * EDGE_RATIO);
  const hasEdge = edgePoints.length > 0;

  return Array.from({ length: COUNT }, (_, i) => {
    if (i < edgeCount && hasEdge) {
      const k = Math.floor(Math.random() * (edgePoints.length / 2)) * 2;
      const x = edgePoints[k] + (Math.random() - 0.5) * 3;
      const y = edgePoints[k + 1] + (Math.random() - 0.5) * 3;
      return {
        x,
        y,
        ox: x,
        oy: y,
        life: EDGE_LIFE_MIN + Math.random() * EDGE_LIFE_RANGE,
        edge: true,
      };
    }
    const x = Math.random() * width;
    const y = Math.random() * height;
    return { x, y, ox: x, oy: y, life: 100 + Math.random() * 260, edge: false };
  });
}

/**
 * Which sprite each particle draws. Fixed at seed time so the `sprites` array
 * stays a static prop, index-aligned with the animated transform buffer.
 */
function buildSprites(particles: Particle[]): SkRect[] {
  return particles.map((p, i) => {
    // Deterministic per index — mirrors the web's random tint ratios without
    // needing to re-pick a sprite every respawn.
    const tint = ((i * 2654435761) % 1000) / 1000;
    const cell = p.edge
      ? tint < GLOW_ORANGE_RATIO
        ? CELL_GLOW_ORANGE
        : CELL_GLOW_WHITE
      : tint < AMBIENT_ORANGE_RATIO
        ? CELL_AMBIENT_ORANGE
        : CELL_AMBIENT;
    return Skia.XYWHRect(cell * CELL, 0, CELL, CELL);
  });
}

// ── Animated field ───────────────────────────────────────────────────────────
function CurrentsField({
  width,
  height,
  markCenterY,
}: {
  width: number;
  height: number;
  markCenterY: number;
}) {
  const image = React.useMemo(makeSpriteSheet, []);
  const edgePoints = React.useMemo(
    () => buildEdgePoints(width, height, markCenterY),
    [width, height, markCenterY]
  );
  const seeded = React.useMemo(
    () => seedParticles(width, height, edgePoints),
    [width, height, edgePoints]
  );
  const sprites = React.useMemo(() => buildSprites(seeded), [seeded]);

  const clock = useClock();
  const particles = useSharedValue<Particle[]>(seeded);

  // Re-seed on resize; the buffer modifier picks it up on its next tick.
  React.useEffect(() => {
    particles.value = seeded;
  }, [seeded, particles]);

  const transforms = useRSXformBuffer(COUNT, (val, i) => {
    'worklet';
    const list = particles.value;
    const p = list[i];
    if (!p) {
      val.set(0, 0, -CELL, -CELL); // park offscreen
      return;
    }

    const now = clock.value;
    const angle = flowAngle(p.x, p.y, now / TIME_SCALE);
    p.x += Math.cos(angle) * SPEED;
    p.y += Math.sin(angle) * SPEED;
    p.life -= 1;

    const gone =
      p.life <= 0 || p.x < -10 || p.x > width + 10 || p.y < -10 || p.y > height + 10;
    if (gone) {
      if (p.edge && edgePoints.length > 0) {
        const k = Math.floor(Math.random() * (edgePoints.length / 2)) * 2;
        p.x = edgePoints[k] + (Math.random() - 0.5) * 3;
        p.y = edgePoints[k + 1] + (Math.random() - 0.5) * 3;
        p.life = EDGE_LIFE_MIN + Math.random() * EDGE_LIFE_RANGE;
      } else {
        p.x = Math.random() * width;
        p.y = Math.random() * height;
        p.life = 100 + Math.random() * 260;
      }
      p.ox = p.x;
      p.oy = p.y;
    }

    if (p.edge) {
      // The mark is only the glow near its outline: bright on the edge, gone by
      // GLOW_DRIFT px away. Cubic ease-in over the first REVEAL_MS.
      const revealRaw = Math.min(1, now / REVEAL_MS);
      const reveal = 1 - Math.pow(1 - revealRaw, 3);
      const dx = p.x - p.ox;
      const dy = p.y - p.oy;
      const fade = clamp01(1 - Math.sqrt(dx * dx + dy * dy) / GLOW_DRIFT);
      const scale = GLOW_SCALE * fade * reveal;
      const half = (CELL * scale) / 2;
      val.set(scale, 0, p.x - half, p.y - half);
      return;
    }

    // Ambient streak, rotated onto the flow direction about the sprite centre.
    const scos = Math.cos(angle) * STREAK_SCALE;
    const ssin = Math.sin(angle) * STREAK_SCALE;
    const a = CELL / 2;
    val.set(scos, ssin, p.x - (scos * a - ssin * a), p.y - (ssin * a + scos * a));
  });

  if (!image) return null;

  return (
    <Canvas style={{ flex: 1 }}>
      <Fill color={INK} />
      <Atlas image={image} sprites={sprites} transforms={transforms} blendMode="plus" />
    </Canvas>
  );
}

// ── Reduced motion — one static frame of the mark, no clock, no simulation ────
function StaticField({
  width,
  height,
  markCenterY,
}: {
  width: number;
  height: number;
  markCenterY: number;
}) {
  const image = React.useMemo(makeSpriteSheet, []);
  const { sprites, transforms } = React.useMemo(() => {
    const points = buildEdgePoints(width, height, markCenterY);
    const s: SkRect[] = [];
    const t: SkRSXform[] = [];
    const half = (CELL * GLOW_SCALE) / 2;
    for (let i = 0; i < points.length; i += 2) {
      const cell = (i / 2) % 5 < 4 ? CELL_GLOW_ORANGE : CELL_GLOW_WHITE;
      s.push(Skia.XYWHRect(cell * CELL, 0, CELL, CELL));
      t.push(Skia.RSXform(GLOW_SCALE, 0, points[i] - half, points[i + 1] - half));
    }
    return { sprites: s, transforms: t };
  }, [width, height, markCenterY]);

  if (!image) return null;

  return (
    <Canvas style={{ flex: 1 }}>
      <Fill color={INK} />
      <Atlas image={image} sprites={sprites} transforms={transforms} blendMode="plus" />
    </Canvas>
  );
}

export type KortixCurrentsProps = {
  style?: React.ComponentProps<typeof View>['style'];
  /** Mark's centre as a fraction of frame height. `0.5` centres it; lower sits higher. */
  markCenterY?: number;
};

/**
 * Full-frame flow field with the Kortix mark hidden inside it. Fills its
 * parent — give it a sized container.
 */
export function KortixCurrents({ style, markCenterY = 0.5 }: KortixCurrentsProps) {
  const [{ width, height }, setSize] = React.useState({ width: 0, height: 0 });
  const [reduceMotion, setReduceMotion] = React.useState(false);

  React.useEffect(() => {
    let alive = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      if (alive) setReduceMotion(enabled);
    });
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);

  const onLayout = React.useCallback((e: LayoutChangeEvent) => {
    const { width: w, height: h } = e.nativeEvent.layout;
    setSize((prev) =>
      Math.round(prev.width) === Math.round(w) && Math.round(prev.height) === Math.round(h)
        ? prev
        : { width: w, height: h }
    );
  }, []);

  return (
    <View style={[{ flex: 1, backgroundColor: INK }, style]} onLayout={onLayout}>
      {width > 0 && height > 0 ? (
        reduceMotion ? (
          <StaticField width={width} height={height} markCenterY={markCenterY} />
        ) : (
          <CurrentsField width={width} height={height} markCenterY={markCenterY} />
        )
      ) : null}
    </View>
  );
}
