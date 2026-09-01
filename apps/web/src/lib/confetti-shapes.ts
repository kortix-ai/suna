/**
 * Turning a workspace's face (`lib/confetti-identity.ts`) into the particles
 * `canvas-confetti` actually throws.
 *
 * Every shape here is a `type: 'bitmap'` shape, including the emoji — which is
 * what `confetti.shapeFromText` already produces. One kind for all three faces
 * means one set of geometry rules and one failure mode, instead of a path
 * shape for the glyph (which would drag in a second, hex-only colour path —
 * canvas-confetti parses the `colors` option with a HEX-only reader, and this
 * app's glyph colours are `light-dark()` token pairs that resolve to `rgb()`).
 * A bitmap carries its own colour, so the theme-resolved value goes straight
 * onto `fillStyle` and nothing has to be converted.
 *
 * ## The geometry, and why these exact numbers
 *
 * `canvas-confetti` draws a bitmap shape as a `no-repeat` pattern under a
 * `DOMMatrix` (`confetti.js:412-440`). The library's own `shapeFromText` sets
 * the convention: render at `10 * scalar` px, then hand back `scale = 1 /
 * scalar`, so the particle lands at ~10 canvas units — the size of the plain
 * square confetti it sits beside.
 *
 * These bitmaps are rendered at `10 * scalar * RESOLUTION` and scaled back by
 * `1 / (scalar * RESOLUTION)`. Same 10-unit result, `RESOLUTION`x the texture.
 * That matters here and not for `shapeFromText`: an emoji is a soft colour
 * bitmap that reads fine blurred, while a Phosphor glyph is hard geometry and
 * a chalk tile has a 1px border — both show resampling immediately on a 2x
 * display, where the confetti canvas is itself scaled by `devicePixelRatio`.
 *
 * ## The `matrix` type is a lie, deliberately
 *
 * `@types/canvas-confetti` declares `matrix: DOMMatrix`. The runtime wants a
 * SIX-NUMBER ARRAY: it does `new DOMMatrix(fetti.shape.matrix)`, whose WebIDL
 * init is `(DOMString or sequence<unrestricted double>)` — and a `DOMMatrix`
 * instance is neither, so passing one throws. The library's own
 * `shapeFromText` returns an array (`confetti.js:853`). We match the runtime
 * and cast at the boundary; see `toShapeMatrix`.
 */
import confetti from 'canvas-confetti';

/**
 * Particle size, as a multiple of the 10px default.
 *
 * 2 for the same reason `EntityAvatar` gives an emoji its own type step: at
 * the default scalar a project glyph is a 10px smudge. At 2 the silhouette of
 * a Phosphor icon and the letter inside a chalk tile are both still readable
 * mid-flight, and the particle is still smaller than the avatar it came from.
 */
export const IDENTITY_SCALAR = 2;

/** Texture multiplier — see the geometry note in the file header. */
const RESOLUTION = 3;

/** Phosphor's icon canvas. Every glyph in the catalogue is drawn in this box. */
const PHOSPHOR_VIEWBOX = 256;

/**
 * `EntityAvatar`'s `rounded-md` on a `size-8` tile: 6px radius in a 29.44px
 * box. Expressed as a ratio so the tile keeps its proportions at any
 * `RESOLUTION`.
 */
const TILE_RADIUS_RATIO = 6 / 29.44;

/** The initial's type size inside its tile, matching `size-8` + `text-xs`. */
const TILE_TEXT_RATIO = 13 / 29.44;

/**
 * `OffscreenCanvas` gates every shape here, and `shapeFromText` needs it too
 * (`confetti.js:827`). Absent it, callers get `null` and confetti falls back
 * to its default squares and circles — a plain burst, not a broken one.
 */
function canRender(): boolean {
  return typeof OffscreenCanvas !== 'undefined' && typeof Path2D !== 'undefined';
}

/** See the header: the runtime wants the array, the types want the class. */
function toShapeMatrix(scale: number, size: number): DOMMatrix {
  return [scale, 0, 0, scale, (-size * scale) / 2, (-size * scale) / 2] as unknown as DOMMatrix;
}

function bitmapShape(
  size: number,
  paint: (ctx: OffscreenCanvasRenderingContext2D, size: number) => void,
): confetti.Shape | null {
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  paint(ctx, size);

  return {
    type: 'bitmap',
    bitmap: canvas.transferToImageBitmap(),
    matrix: toShapeMatrix(1 / (IDENTITY_SCALAR * RESOLUTION), size),
  };
}

/**
 * The workspace's emoji, as-is.
 *
 * Straight to `confetti.shapeFromText` rather than a hand-rolled bitmap: it
 * already carries the cross-platform colour-emoji font stack (Apple Color
 * Emoji / Noto Color Emoji / Twemoji Mozilla / …), and getting that list wrong
 * is how an emoji silently renders as a monochrome outline on one OS.
 */
export function emojiConfettiShape(emoji: string): confetti.Shape | null {
  if (!canRender()) return null;
  try {
    return confetti.shapeFromText({ text: emoji, scalar: IDENTITY_SCALAR });
  } catch {
    // `measureText` on a grapheme the platform cannot render can produce a
    // zero-size canvas, and `new OffscreenCanvas(0, 0)` throws. Fall back to
    // the default shapes rather than take the celebration down with it.
    return null;
  }
}

/**
 * The workspace's glyph, in the colour it was given.
 *
 * `path` is the `d` of the mounted Phosphor `<path>` and `color` is the
 * theme-resolved `--color-glyph-ring-*` — both read off a live probe element
 * by the caller (`components/ui/identity-confetti.tsx`). Neither is derivable
 * here: the path lives inside a React component's weight map with no string
 * export, and the colour is a `light-dark()` pair that only a rendered element
 * can resolve.
 */
export function glyphConfettiShape(path: string, color: string): confetti.Shape | null {
  if (!canRender() || !path) return null;

  const size = 10 * IDENTITY_SCALAR * RESOLUTION;
  return bitmapShape(size, (ctx) => {
    ctx.scale(size / PHOSPHOR_VIEWBOX, size / PHOSPHOR_VIEWBOX);
    // Assigning an unparseable colour leaves `fillStyle` at its previous
    // value, so the black seeded here IS the fallback — no branch needed.
    ctx.fillStyle = '#000000';
    ctx.fillStyle = color;
    ctx.fill(new Path2D(path));
  });
}

/**
 * The initial's chalk tile — fill, 1px border and letter — not a bare letter.
 *
 * A workspace with no icon does not look like an "R" on screen; it looks like
 * `EntityAvatar`'s hash-coloured rounded tile WITH an R in it. Throwing bare
 * letters would celebrate something the user has never seen. `chalk` is
 * `chalkColors(label)` from `@kortix/shared` — the same three `hsl()` strings
 * the tile paints with, usable as `fillStyle` verbatim.
 */
export function initialConfettiShape(
  initial: string,
  chalk: { background: string; foreground: string; border: string },
  fontFamily: string,
): confetti.Shape | null {
  if (!canRender()) return null;

  const size = 10 * IDENTITY_SCALAR * RESOLUTION;
  return bitmapShape(size, (ctx) => {
    const radius = size * TILE_RADIUS_RATIO;
    const border = Math.max(1, Math.round(RESOLUTION / 2));
    const inset = border / 2;

    ctx.beginPath();
    ctx.roundRect(inset, inset, size - border, size - border, radius);
    ctx.fillStyle = chalk.background;
    ctx.fill();
    ctx.lineWidth = border;
    ctx.strokeStyle = chalk.border;
    ctx.stroke();

    ctx.fillStyle = chalk.foreground;
    ctx.font = `600 ${size * TILE_TEXT_RATIO}px ${fontFamily}`;
    ctx.textAlign = 'center';
    // `middle` centres on the font's own x-height-ish midpoint, which for a
    // single uppercase letter sits low. Centring on the MEASURED cap height
    // instead puts the letter optically in the tile — the same correction the
    // tile itself gets for free from flexbox.
    ctx.textBaseline = 'alphabetic';
    const metrics = ctx.measureText(initial);
    const capHeight = metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent;
    ctx.fillText(initial, size / 2, size / 2 + capHeight / 2 - metrics.actualBoundingBoxDescent);
  });
}
