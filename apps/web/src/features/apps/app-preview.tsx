'use client';

import Loading from '@/components/ui/loading';

import { useTranslations } from '@/i18n/use-translations';

import { CLIPBOARD_IFRAME_ALLOW, INTERACTIVE_PREVIEW_IFRAME_SANDBOX } from '@/lib/security/iframe-sandbox';

import { cn } from '@/lib/utils';
import { type App } from '@kortix/sdk';

import { useEffect, useLayoutEffect, useState } from 'react';


/**
 * How long a frame may take before we admit out loud that it is loading.
 *
 * A warm App paints far inside this — the card thumbnail already fetched the
 * signed URL, so the modal's frame is the second request for a document the
 * browser has cached. Painting the overlay from mount made every one of those
 * flash a spinner for a single frame on the way in, which reads as SLOWER than
 * showing nothing. Below the threshold the frame area stays on its calm
 * `bg-muted/20` surface and the App simply appears.
 */
export const PREVIEW_SPINNER_DELAY_MS = 280;

/**
 * The delay timer, extracted from the effect so the threshold is testable.
 * `apps/web` has no DOM test harness, so a hook's effect cannot be driven from
 * a test — this seam can, with fake timers.
 */
export function scheduleSlowPreview(
  onSlow: () => void,
  delayMs: number = PREVIEW_SPINNER_DELAY_MS,
): () => void {
  const timer = setTimeout(onSlow, delayMs);
  return () => clearTimeout(timer);
}

/**
 * True once a still-pending frame has passed the threshold above.
 *
 * There is no reset branch because there is nothing to reset: `pending` only
 * ever goes true → false (the frame loads, or it errors), and a frame that has
 * settled is covered by `loaded` / `failed`. A remount — a new deployment — gets
 * a fresh `key` from the caller and therefore fresh state.
 */
function useSlowPreview(pending: boolean): boolean {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!pending) return;
    return scheduleSlowPreview(() => setSlow(true));
  }, [pending]);
  return slow;
}

/**
 * What covers the frame while it is not showing the App.
 *
 * Exported for its own test: the whole point of this component is the state it
 * DOESN'T render (no spinner before the threshold), which is only assertable
 * against markup.
 */
export function AppPreviewOverlay({
  loaded,
  failed,
  slow,
}: {
  loaded: boolean;
  failed: boolean;
  slow: boolean;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  // A failure is never worth waiting to report — `onError` means the frame is
  // done and it is not going to paint.
  if (!failed && (loaded || !slow)) return null;
  return (
    <div className="bg-background/95 absolute inset-0 flex items-center justify-center px-6 text-center backdrop-blur-sm">
      <div className="text-muted-foreground flex items-center gap-2 text-xs">
        {failed ? null : <Loading className="size-4 shrink-0" />}
        <span>
          {failed ? tI18nComplete.raw('texte89cabb62100') : tI18nComplete.raw('text8f624e45d6bf')}
        </span>
      </div>
    </div>
  );
}

/**
 * The logical viewport a CARD thumbnail renders the App into, and the shape of
 * the tile it lands in. These three constants are ONE decision — see the ratio
 * note below — so they live together.
 *
 * A card tile is narrower than a laptop, and an iframe that wide is a viewport
 * that wide — so a small tile makes the App answer with its mobile layout.
 * Every thumbnail on the page was a hamburger over a single stacked column: the
 * one view of the App nobody deploys an App for, and nothing like what opening
 * it actually shows.
 *
 * Render at a desktop width instead and scale the result down. The App lays
 * out at 1080px — still a desktop breakpoint, so no App answers with its
 * hamburger — and the tile shows that layout in miniature.
 *
 * **The ratio is load-bearing.** The frame is scaled to the tile's WIDTH, so
 * any mismatch between the viewport's aspect and the tile's shows up as dead
 * space at the bottom of every tile (viewport shorter) or a crop (taller).
 * 1280x720 is 16:9 exactly, which is `PREVIEW_TILE_ASPECT`, so the scaled frame
 * fills the tile edge to edge. Change one, change the other — the parity is
 * asserted in `app-preview.test.tsx`.
 *
 * The width and the height answer two different questions, and only the second
 * is about the ratio. The viewport WIDTH decides which layout the App renders,
 * and 1280px is a desktop breakpoint — no App answers the thumbnail with its
 * hamburger. The viewport HEIGHT decides how far down that page the thumbnail
 * reaches: 720px of a 1280px-wide page is roughly the header and the top of the
 * hero.
 *
 * The ratio is a row-height decision: every candidate trades how much page a
 * tile shows against how many rows fit a screen, at a fixed tile width.
 *
 *   | ratio      | height/width | tile at cap | four-across row              |
 *   | ---        | ---          | ---         | ---                          |
 *   | **`16/9`** | **0.56x**    | **300x169** | **three rows and change**    |
 *   | `1/1`      | 1.00x        | 300x300     | two rows and part of a third |
 *   | `4/5`      | 1.25x        | 300x375     | two rows on a laptop         |
 *   | `3/4`      | 1.33x        | 300x400     | a row and a half             |
 *   | `2/3`      | 1.50x        | 300x450     | a row and a third            |
 *   | `9/16`     | 1.78x        | 300x533     | about one row                |
 *
 * **This ratio has moved twice, so read the history before moving it again.**
 * 16:9 shipped, was replaced by 4:5 (`e56c580271`), reverted back to 16:9
 * (`e6c4ba0b62`), then set to 4:5 a second time — and is now 16:9 again by
 * Jay's call on 2026-08-31. The recorded objection to 16:9 is that a tile is a
 * letterbox: at the cap it is 300x169, and the App inside it is a 1280px page
 * at 23% scale, so a thumbnail shows about the header and the top of the hero
 * rather than a hero plus the section under it. The counter-argument, and the
 * reason it keeps coming back, is that 16:9 is the shape a web page is actually
 * screenshotted in and three rows fit a laptop instead of two.
 *
 * The thing that genuinely broke a previous attempt was never the ratio: 4:5
 * paired with a `max-w-5xl` cap and a fixed four-column grid gave a 230px tile,
 * the App at 18% scale, every card the same grey rectangle. The cap is
 * `max-w-7xl` now and the columns come from a container ladder floored at
 * ~232px. Keep that floor whatever the ratio is.
 *
 * At the three columns a docked desktop lands on by default
 * (`APP_GRID_COLUMN_OPTIONS`), a tile is ~320x180 — the App at ~25% scale. At
 * the cap it is ~405x228, or ~32%.
 *
 * Note what does NOT solve the mobile-layout problem — `showAspectRatioToCSS`
 * in `show-content-renderer.tsx` reshapes the BOX and leaves the guest laying
 * out at the host's width, which is the thing that produced it here.
 */
export const PREVIEW_VIEWPORT_WIDTH = 1280;
export const PREVIEW_VIEWPORT_HEIGHT = 720;
/** The tile's shape, written once so the class and the viewport cannot drift. */
export const PREVIEW_TILE_ASPECT = 'aspect-[16/9]';

/**
 * How far to shrink the desktop frame so it fits the tile. `null` for a width
 * nothing can be concluded from — a detached node, a display:none ancestor, a
 * server render with no layout at all — which the caller paints as "not yet
 * measured" rather than scaling by a garbage factor.
 */
export function previewScale(
  containerWidth: number,
  viewportWidth: number = PREVIEW_VIEWPORT_WIDTH,
): number | null {
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) return null;
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) return null;
  return containerWidth / viewportWidth;
}

/**
 * Measures the tile and keeps the scale honest as it changes.
 *
 * A layout effect, not an effect: it runs after DOM mutation and BEFORE paint,
 * so the browser never shows the unscaled 1080px frame cropped to the tile's
 * top-left corner. The `ResizeObserver` then covers every later change — the
 * responsive grid going one-column, a sidebar opening, a window drag — none of
 * which fire anything else this component would hear.
 */
function useDesktopViewportScale(enabled: boolean) {
  // A callback ref held in state, not a `useRef`: the node is an INPUT to the
  // measurement, so the effect has to re-run when it arrives. A ref object
  // would also have to be read during render to be handed to `<div ref>`,
  // which is the thing `react-hooks/refs` correctly refuses.
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const [scale, setScale] = useState<number | null>(null);

  useLayoutEffect(() => {
    if (!enabled || !node) return;

    const measure = () => setScale(previewScale(node.getBoundingClientRect().width));
    measure();

    // Guarded for a runtime without it (jsdom-less unit renders, older Safari):
    // the one synchronous measurement above still lands, so the frame is scaled
    // correctly at its mounted size and simply stops tracking resizes.
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [enabled, node]);

  // A tuple, not an object. `react-hooks/refs` treats every property read on an
  // object whose member lands in a `ref=` prop as a ref access during render —
  // true for a `useRef` container, wrong for a callback ref. Destructuring to
  // plain locals says what this is and keeps the rule meaningful where it does
  // apply.
  return [setNode, scale] as const;
}

export function AppPreview({
  app,
  url,
  accessError,
  /**
   * `false` on a CARD: the card is one big button, and a live iframe would
   * swallow every click meant for it (and let someone interact with a page
   * inside a 300px tile). The card renders the frame purely as a thumbnail and
   * the card takes the click. `true` in the detail modal, where the frame IS
   * the App.
   */
  interactive,
  className,
}: {
  app: App;
  url: string | null;
  accessError: boolean;
  interactive: boolean;
  className?: string;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const slow = useSlowPreview(!loaded && !failed);
  // Cards only. In the modal the frame IS the App at the size you are using it,
  // so a fixed desktop viewport there would scale the thing you came to click.
  const [attachViewport, viewportScale] = useDesktopViewportScale(!interactive);
  const frame = cn(
    'bg-muted/20 relative overflow-hidden',
    !interactive && PREVIEW_TILE_ASPECT,
    className,
  );

  if (!app.active_deployment_id) {
    return (
      <div
        className={cn(
          frame,
          'text-muted-foreground flex items-center justify-center px-6 text-center text-xs text-pretty',
        )}
        data-testid="app-preview-empty"
      >
        {tI18nComplete.raw('text3efdcf91931a')}
      </div>
    );
  }

  if (!url) {
    return (
      <div
        className={cn(
          frame,
          'text-muted-foreground flex items-center justify-center px-6 text-center text-xs text-pretty',
        )}
        data-testid={accessError ? 'app-preview-access-denied' : 'app-preview-loading'}
      >
        {accessError ? (
          tI18nComplete.raw('texteccce15347a4')
        ) : (
          <span className="flex items-center gap-2">
            <Loading className="size-4 shrink-0" />
            {tI18nComplete.raw('text2158038765cc')}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className={frame} ref={attachViewport}>
      <iframe
        key={app.active_deployment_id}
        src={url}
        title={tI18nComplete('text04132f84d7c3', { value0: app.name })}
        style={
          interactive
            ? undefined
            : {
                width: PREVIEW_VIEWPORT_WIDTH,
                height: PREVIEW_VIEWPORT_HEIGHT,
                // Hidden, not unmounted, until the tile has been measured: an
                // unmounted frame would restart the document load on every
                // resize, and a visible unscaled one would flash the App's
                // top-left 1080px corner. It still loads while hidden.
                ...(viewportScale === null
                  ? { visibility: 'hidden' as const }
                  : { transform: `scale(${viewportScale})` }),
              }
        }
        // The card thumbnail is one of many below the fold, so defer it. In the
        // modal the frame IS the content and it is already on screen — `lazy`
        // there makes the browser wait for layout before it even starts the
        // fetch, which is pure added latency on the one open that must feel
        // instant.
        loading={interactive ? 'eager' : 'lazy'}
        allow={CLIPBOARD_IFRAME_ALLOW}
        sandbox={INTERACTIVE_PREVIEW_IFRAME_SANDBOX}
        className={cn(
          'bg-background absolute border-0',
          interactive
            ? 'inset-0 size-full'
            : // Anchored top-left because that is the scale's origin: the frame
              // shrinks toward the corner it starts in, so the miniature lands
              // flush in the tile instead of drifting toward the middle.
              'pointer-events-none top-0 left-0 origin-top-left',
        )}
        {...(interactive ? {} : { tabIndex: -1, 'aria-hidden': true })}
        data-testid="app-live-preview"
        onLoad={() => {
          setLoaded(true);
          setFailed(false);
        }}
        onError={() => {
          setLoaded(false);
          setFailed(true);
        }}
      />
      <AppPreviewOverlay loaded={loaded} failed={failed} slow={slow} />
    </div>
  );
}
