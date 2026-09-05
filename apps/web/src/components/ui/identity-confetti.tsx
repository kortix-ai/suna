'use client';

/**
 * A confetti burst made of ONE workspace's own icon.
 *
 * Not a decoration you point at a page — a portrait of a specific workspace,
 * thrown in the air. Whatever `EntityAvatar` would draw for that workspace is
 * what the particles are:
 *
 *   - an emoji project throws its emoji, as-is;
 *   - a glyph project throws its Phosphor icon, in the colour it was given;
 *   - a project with neither throws its chalk initial tile — the fill, the
 *     1px border and the letter, exactly the tile it wears in the grid.
 *
 * The precedence between those three is NOT decided here. It lives in
 * `lib/confetti-identity.ts`, which is the extracted copy of
 * `EntityAvatar`'s own chain, so a workspace can never celebrate with a face
 * it does not wear.
 *
 * ## Why there is a hidden probe in the DOM
 *
 * The glyph branch needs two things that exist only in a rendered element:
 *
 *   1. The path data. `@phosphor-icons/react` keeps each weight as a React
 *      element in a module-private `Map` (`dist/defs/<Name>.es.js`) — there is
 *      no string export to read, and `renderToStaticMarkup` would pull
 *      `react-dom/server` into the client bundle to get one.
 *   2. The colour. `--color-glyph-ring-*` is a `light-dark()` pair
 *      (`globals.css:349-356`). `getPropertyValue` on a custom property hands
 *      back the unresolved `light-dark(a, b)` text; only an element with a
 *      known `color-scheme` resolves it.
 *
 * So the component renders the glyph once, `hidden`, and reads both off it.
 * `hidden` is `display: none`, which costs no layout and does not stop either
 * read: `d` is an attribute, and `color` is a computed value, not a laid-out
 * one.
 *
 * The emoji and initial branches need no probe. The emoji goes straight to
 * `confetti.shapeFromText`, and `chalkColors()` already returns plain `hsl()`
 * strings.
 *
 * ## Why the canvas is portalled
 *
 * The production host renders this INSIDE a Radix dialog, and a `fixed`
 * element does not reliably escape one. `ModalContent`
 * (`components/ui/modal.tsx:124-125`) is `fixed ... overflow-y-auto` and, from
 * the `lg` breakpoint up, `-translate-x-1/2 -translate-y-1/2`. A transform
 * makes an element the containing block for every fixed descendant, so above
 * `lg` an inline canvas is pinned to the modal panel and cropped by its
 * `overflow-y-auto` — the confetti would go off inside a box in the middle of
 * the screen.
 *
 * `z-50` does not survive the trip either: `modal.tsx:278` sets the content's
 * z-index from `dialogContentZ(depth)`, which is 9999 at depth 1
 * (`lib/z-stack.tsx:25`). `floatingZ(useDialogDepth())` is the value that layer
 * already reserves for things drawn ABOVE a dialog, and it accounts for nested
 * dialogs — the wizard opens `DemoQualifierModal` over itself.
 */

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';

import { Confetti, type ConfettiRef } from '@/components/magicui/confetti';
import { glyphComponent } from '@/components/ui/glyph-registry';
import { glyphForeground } from '@/components/ui/glyph-tint';
import { resolveConfettiFace, type ConfettiIdentity } from '@/lib/confetti-identity';
import {
  IDENTITY_SCALAR,
  emojiConfettiShape,
  glyphConfettiShape,
  initialConfettiShape,
} from '@/lib/confetti-shapes';
import { DEFAULT_ICON_WEIGHT } from '@/lib/icons/icon-config';
import { floatingZ, useDialogDepth } from '@/lib/z-stack';
import { chalkColors } from '@kortix/shared';
import type confetti from 'canvas-confetti';

/**
 * How long the canvas stays mounted after the burst.
 *
 * `ticks` below is the per-particle lifetime in animation frames, so the last
 * particle is gone at `ticks / 60`s. Unmounting earlier calls
 * `instance.reset()` and wipes particles still in the air; leaving the canvas
 * up forever parks a `fixed inset-0` compositing layer over the app for the
 * rest of the session. 300ms of slack covers a throttled background tab
 * catching up.
 */
/**
 * "Are we on the client yet?", without a `setState` in an effect.
 *
 * `useSyncExternalStore` with a no-op subscribe is this repo's shape for a
 * client-only value (`features/workspace/project-layout/home/
 * setup-checklist.tsx`): the server snapshot is `false`, so hydration matches,
 * and the client snapshot is `true`. The alternative — `useState(false)` plus
 * an effect that sets it — trips `react-hooks/set-state-in-effect` and costs an
 * extra render for the same answer.
 */
const NEVER_CHANGES = () => () => {};
const ON_CLIENT = () => true;
const ON_SERVER = () => false;

const TICKS = 160;
const TEARDOWN_MS = (TICKS / 60) * 1000 + 300;

/**
 * Three layers, one origin — the `canvas-confetti` "realistic" recipe, retuned
 * for particles that are ~4x the area of a default square.
 *
 * `startVelocity` and `count` are both well under `lib/confetti.ts`'s billing
 * burst (200 particles at 55). An emoji or a glyph carries far more visual
 * weight than a 10px chip, so the same numbers read as a screen full of debris
 * rather than a celebration. `decay` is high and `gravity` low so the icons
 * hang long enough to be RECOGNISED, which is the entire point of the feature.
 */
const LAYERS: readonly confetti.Options[] = [
  { particleCount: 18, spread: 70, startVelocity: 34 },
  { particleCount: 12, spread: 110, startVelocity: 26, decay: 0.93 },
  { particleCount: 8, spread: 130, startVelocity: 42, decay: 0.92 },
];

export interface IdentityConfettiProps extends ConfettiIdentity {
  /**
   * Fires on the false -> true edge, once per mount. Defaults to true, which
   * is the common case: the component is mounted AT the moment worth
   * celebrating and does not outlive it.
   */
  active?: boolean;
  /** Burst origin in canvas fractions. Defaults to slightly above centre. */
  origin?: { x: number; y: number };
}

/**
 * The glyph's drawing component, wrapped in an object rather than returned
 * bare.
 *
 * Not a style preference: rendering a bare `<GlyphComponent />` read out of a
 * registry during render trips `react-hooks/static-components` ("Cannot create
 * components during render"), because the rule cannot tell a lookup from a
 * factory. `entity-avatar.tsx` and `project-icon-field.tsx` both solve it the
 * same way — hand back an object and render the member expression — so this
 * file stays consistent with the two components it mirrors.
 *
 * `null` for a name the registry does not know. Same fall-through
 * `EntityAvatar` performs: no probe renders, `buildShape` returns `null`, and
 * the burst degrades to default shapes rather than to nothing.
 */
function resolveGlyphFace(name: string, color: string) {
  const GlyphComponent = glyphComponent(name);
  return GlyphComponent ? { GlyphComponent, color } : null;
}

export function IdentityConfetti({
  glyph,
  emoji,
  label,
  active = true,
  origin = { x: 0.5, y: 0.45 },
}: IdentityConfettiProps) {
  const face = resolveConfettiFace({ glyph, emoji, label });
  const confettiRef = useRef<ConfettiRef>(null);
  const probeRef = useRef<HTMLSpanElement>(null);
  const [mounted, setMounted] = useState(true);
  // `document.body` does not exist while this renders on the server, and
  // `createPortal` throws on a null container.
  const portalReady = useSyncExternalStore(NEVER_CHANGES, ON_CLIENT, ON_SERVER);
  const depth = useDialogDepth();

  const glyphFace = face.kind === 'glyph' ? resolveGlyphFace(face.name, face.color) : null;

  // Keyed on `active` alone, which is what makes this fire ONCE: a parent
  // re-render does not re-run an effect whose deps did not change, so no extra
  // latch is needed. A deliberate false -> true -> false -> true toggle fires
  // again, which is the behaviour a host asking for that toggle wants.
  //
  // Deliberately NOT latched in a ref. Under React Strict Mode the effect is
  // torn down and re-run on mount, and `canvasRef(null)` calls
  // `instance.reset()` in between — so a latch would let the FIRST burst fire,
  // wipe it, and then suppress the second. The visible result in development
  // would be no confetti at all.
  useEffect(() => {
    // `portalReady` gates on the canvas EXISTING, not merely on hydration:
    // `confettiRef` is attached during the commit that mounts the portal, and
    // this effect runs after it.
    if (!active || !portalReady) return;

    const shape = buildShape(face, probeRef.current);
    // `undefined`, not `[]`: an empty `shapes` array makes canvas-confetti
    // pick from nothing and draw no particles at all. Leaving it off restores
    // the library default (squares and circles), so a browser without
    // `OffscreenCanvas` — or a glyph whose probe failed to render — still
    // celebrates, just generically.
    const shapes = shape ? [shape] : undefined;

    for (const layer of LAYERS) {
      confettiRef.current?.fire({
        ...layer,
        origin,
        ticks: TICKS,
        gravity: 0.75,
        scalar: IDENTITY_SCALAR,
        shapes,
      });
    }

    const timer = window.setTimeout(() => setMounted(false), TEARDOWN_MS);
    return () => window.clearTimeout(timer);
    // `face` and `origin` are fresh objects on every render, so listing them
    // would re-fire the burst on any parent re-render. Both are read at fire
    // time from the current render's values, which is what this effect wants.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, portalReady]);

  if (!mounted) return null;

  return (
    <>
      {glyphFace ? (
        <span ref={probeRef} hidden aria-hidden className={glyphForeground(glyphFace.color)}>
          {/* The weight is passed explicitly rather than inherited from
              `IconProvider`: the probe is read one frame after mount and must
              produce the same `d` no matter where in the tree it is hung. */}
          <glyphFace.GlyphComponent weight={DEFAULT_ICON_WEIGHT} />
        </span>
      ) : null}
      {portalReady
        ? createPortal(
            <Confetti ref={confettiRef} manualstart style={{ zIndex: floatingZ(depth) }} />,
            document.body,
          )
        : null}
    </>
  );
}

/**
 * The face -> shape step, split out so the effect above reads as "fire", not
 * as a switch. Returns `null` for every unsupported case — see the `shapes`
 * comment at the call site for what that degrades to.
 */
function buildShape(
  face: ReturnType<typeof resolveConfettiFace>,
  probe: HTMLSpanElement | null,
): confetti.Shape | null {
  if (face.kind === 'emoji') return emojiConfettiShape(face.emoji);

  if (face.kind === 'glyph') {
    if (!probe) return null;
    // Phosphor's bold weight is a single filled `<path>` in a 0 0 256 256
    // viewBox (`dist/lib/IconBase.es.js`). Other weights can be two, so the
    // `d`s are joined — SVG path data concatenates into one Path2D as
    // independent subpaths, and every weight in this app fills rather than
    // strokes.
    const path = Array.from(probe.querySelectorAll('path'))
      .map((node) => node.getAttribute('d'))
      .filter(Boolean)
      .join(' ');
    return glyphConfettiShape(path, window.getComputedStyle(probe).color);
  }

  // `chalkSeed`, not `initial` — the tile is hashed from the whole label, so
  // seeding on the letter would throw the right letter in the wrong colour.
  return initialConfettiShape(
    face.initial,
    chalkColors(face.chalkSeed),
    window.getComputedStyle(document.body).fontFamily,
  );
}
