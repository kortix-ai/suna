import { describe, expect, jest, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { stripTags } from '@/test-utils/strip-tags';
import type { App } from '@kortix/sdk';

import {
  APP_GRID_COLUMNS,
  APP_GRID_CONTAINER,
  AppPreview,
  AppPreviewOverlay,
  DEPLOYMENT_COPY,
  appHost,
  deployNotice,
  PREVIEW_SPINNER_DELAY_MS,
  PREVIEW_TILE_ASPECT,
  PREVIEW_VIEWPORT_HEIGHT,
  PREVIEW_VIEWPORT_WIDTH,
  previewScale,
  scheduleSlowPreview,
} from './apps-view';

/**
 * The defect these tests pin: opening a warm App flashed a spinner.
 *
 * A card renders a live frame of the deployed App. Clicking it opens the detail
 * modal, which mounts a SECOND frame on the same signed URL — a document the
 * browser already has. That load finishes in well under 200ms, and the overlay
 * still painted for a frame on the way in, so the instant thing looked slow.
 *
 * `apps/web` has no DOM testing library and none may be added (see
 * `provider-connect.test.tsx`), so this splits the way the repo already splits
 * such things: `renderToStaticMarkup` asserts what each state RENDERS, and fake
 * timers assert WHEN the state flips.
 */

const APP: App = {
  app_id: 'app-1',
  account_id: 'acc-1',
  project_id: 'proj-1',
  slug: 'seed',
  name: 'Seed App',
  url: 'https://seed.apps.kortix.com',
  access_mode: 'project',
  access_revision: 1,
  desired_state: 'running',
  active_deployment_id: 'dep-1',
  machine: { cpu: 1, memory_gb: 2, disk_gb: 10 },
  idle_timeout_seconds: 300,
  monthly_budget_usd: 5,
  last_request_at: null,
  viewer_can_access: true,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

const URL = 'https://seed.apps.kortix.com/?__kortix_access=tok';

describe('AppPreview — first paint', () => {
  test('mounts with no spinner at all: the overlay is not in the initial markup', () => {
    // `renderToStaticMarkup` runs render and skips effects, which is exactly
    // the moment under test — t=0, before the delay timer could ever fire.
    const html = renderToStaticMarkup(
      <AppPreview app={APP} url={URL} accessError={false} interactive />,
    );

    expect(html).toContain('data-testid="app-live-preview"');
    expect(stripTags(html)).not.toContain('Loading preview');
    expect(html).not.toContain('backdrop-blur-sm');
  });

  test('the modal frame fetches eagerly, the card thumbnail stays lazy', () => {
    const modal = renderToStaticMarkup(
      <AppPreview app={APP} url={URL} accessError={false} interactive />,
    );
    const card = renderToStaticMarkup(
      <AppPreview app={APP} url={URL} accessError={false} interactive={false} />,
    );

    expect(modal).toContain('loading="eager"');
    expect(card).toContain('loading="lazy"');
  });

  test('the frame area stays on its calm surface — no overlay to hide it', () => {
    const html = renderToStaticMarkup(
      <AppPreview app={APP} url={URL} accessError={false} interactive />,
    );

    expect(html).toContain('bg-muted/20');
  });
});

describe('AppPreviewOverlay', () => {
  test('renders nothing before the delay elapses', () => {
    expect(
      renderToStaticMarkup(<AppPreviewOverlay loaded={false} failed={false} slow={false} />),
    ).toBe('');
  });

  test('renders the loading state once the load outruns the delay', () => {
    const html = renderToStaticMarkup(<AppPreviewOverlay loaded={false} failed={false} slow />);

    expect(stripTags(html)).toContain('Loading preview');
    expect(html).toContain('animate-spinner');
  });

  test('disappears on load, even after the delay already elapsed', () => {
    expect(renderToStaticMarkup(<AppPreviewOverlay loaded failed={false} slow />)).toBe('');
  });

  test('reports failure immediately, without waiting for the delay', () => {
    // `onError` means the frame is done and will not paint. Nothing is gained
    // by holding that back behind the anti-flash timer.
    const html = renderToStaticMarkup(<AppPreviewOverlay loaded={false} failed slow={false} />);

    expect(stripTags(html)).toContain('Preview unavailable. Open the App to retry.');
    expect(html).not.toContain('animate-spinner');
  });
});

describe('scheduleSlowPreview', () => {
  test('does not fire before the threshold, and fires after it', () => {
    jest.useFakeTimers();
    try {
      let slow = false;
      scheduleSlowPreview(() => {
        slow = true;
      });

      jest.advanceTimersByTime(PREVIEW_SPINNER_DELAY_MS - 1);
      expect(slow).toBe(false);

      jest.advanceTimersByTime(2);
      expect(slow).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  test('a warm load that finishes inside the threshold never fires', () => {
    // The whole point: the cleanup runs when `onLoad` flips the frame out of
    // its pending state, so the spinner is never scheduled into existence.
    jest.useFakeTimers();
    try {
      let slow = false;
      const cancel = scheduleSlowPreview(() => {
        slow = true;
      });

      jest.advanceTimersByTime(120);
      cancel();
      jest.advanceTimersByTime(10_000);

      expect(slow).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  test('the threshold is short enough to stay under a perceived stall', () => {
    expect(PREVIEW_SPINNER_DELAY_MS).toBeGreaterThanOrEqual(200);
    expect(PREVIEW_SPINNER_DELAY_MS).toBeLessThanOrEqual(400);
  });
});

/**
 * The second defect: a card thumbnail showed the App's MOBILE layout.
 *
 * A tile is ~300-450px wide, and an iframe that wide is a 300-450px viewport,
 * so every App answered the card with its hamburger-and-one-column view — the
 * one layout nobody deploys an App for. The card now renders the App at a
 * desktop viewport and scales the result down, so the tile shows the layout
 * opening the App would show.
 */
describe('previewScale', () => {
  test('shrinks a desktop viewport into the tile it has to fit', () => {
    expect(previewScale(640, 1280)).toBe(0.5);
    expect(previewScale(320, 1280)).toBe(0.25);
  });

  test('defaults to the desktop viewport the card renders at', () => {
    expect(previewScale(PREVIEW_VIEWPORT_WIDTH)).toBe(1);
  });

  test('refuses a width nothing can be concluded from', () => {
    // A detached node, a display:none ancestor, and a server render all measure
    // 0. Scaling by 0 — or by NaN — is how a thumbnail silently disappears.
    for (const width of [0, -10, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(previewScale(width)).toBeNull();
    }
    expect(previewScale(640, 0)).toBeNull();
  });

  test('the viewport ratio IS the tile ratio, parsed from the class itself', () => {
    // The frame is scaled to the tile's WIDTH, so a mismatch here is dead space
    // at the bottom of every thumbnail (viewport shorter than the tile) or a
    // crop (taller). Reading the numbers back out of `PREVIEW_TILE_ASPECT`
    // means changing one constant without the other fails here rather than
    // shipping a page of letterboxed tiles.
    const parsed = /^aspect-\[(\d+)\/(\d+)\]$/.exec(PREVIEW_TILE_ASPECT);
    expect(parsed).not.toBeNull();
    const [, w, h] = parsed as RegExpExecArray;
    expect(PREVIEW_VIEWPORT_WIDTH / PREVIEW_VIEWPORT_HEIGHT).toBeCloseTo(Number(w) / Number(h), 5);
  });

  test('the tile is 4:5 — FINAL, chosen after five candidates', () => {
    // Settled by Jay on 2026-08-27 over 16:9, 9:16, 3:4, 1:1 and 2:3. This is a
    // product decision, not a derived value: it does not move without a new one.
    expect(PREVIEW_TILE_ASPECT).toBe('aspect-[4/5]');
    expect(PREVIEW_VIEWPORT_WIDTH).toBe(1080);
    expect(PREVIEW_VIEWPORT_HEIGHT).toBe(1350);
    expect(PREVIEW_VIEWPORT_WIDTH / PREVIEW_VIEWPORT_HEIGHT).toBeCloseTo(4 / 5, 5);
  });

  test('4:5 works now only because the tile is no longer 230px', () => {
    // 4:5 shipped once (e56c580271) and was reverted (e6c4ba0b62) — paired with
    // a `max-w-5xl` cap and a fixed four-column grid, it produced a 230px tile:
    // the App at 18% scale, every card the same grey rectangle. The ratio was
    // never the fault. At the current cap a four-across tile is 300px.
    const tileAtCap = (1280 - 32 - 3 * 16) / 4;
    expect(tileAtCap).toBeGreaterThan(230);
    expect(tileAtCap * (5 / 4)).toBeCloseTo(375, 0);
  });

  test('the viewport is a desktop width — a phone width would defeat the point', () => {
    // The tile is portrait; the VIEWPORT must not be. 1080px is still past
    // every common desktop breakpoint, so no App answers the thumbnail with
    // its hamburger-and-one-column layout.
    expect(PREVIEW_VIEWPORT_WIDTH).toBeGreaterThanOrEqual(1024);
  });
});

describe('AppPreview — the card renders a desktop viewport', () => {
  test('the card frame is sized to the desktop viewport, not to the tile', () => {
    const html = renderToStaticMarkup(
      <AppPreview app={APP} url={URL} accessError={false} interactive={false} />,
    );

    expect(html).toContain(`width:${PREVIEW_VIEWPORT_WIDTH}px`);
    expect(html).toContain(`height:${PREVIEW_VIEWPORT_HEIGHT}px`);
    expect(html).toContain('origin-top-left');
  });

  test('it stays hidden until measured, rather than flashing an unscaled corner', () => {
    // `renderToStaticMarkup` skips effects, which is exactly the pre-measure
    // state: no layout has happened, so there is no honest scale to apply yet.
    const html = renderToStaticMarkup(
      <AppPreview app={APP} url={URL} accessError={false} interactive={false} />,
    );

    expect(html).toContain('visibility:hidden');
    expect(html).not.toContain('transform:scale');
  });

  test('the modal frame is untouched — it fills the dialog at its real size', () => {
    const html = renderToStaticMarkup(
      <AppPreview app={APP} url={URL} accessError={false} interactive />,
    );

    expect(html).not.toContain(`width:${PREVIEW_VIEWPORT_WIDTH}px`);
    expect(html).not.toContain('visibility:hidden');
    expect(html).toContain('size-full');
  });
});

describe('appHost — the hostname a card reads an App by', () => {
  test('drops the scheme every App shares and any trailing slash', () => {
    expect(appHost('https://seed.apps.kortix.com')).toBe('seed.apps.kortix.com');
    expect(appHost('https://seed.apps.kortix.com/')).toBe('seed.apps.kortix.com');
    expect(appHost('http://seed.apps.kortix.com//')).toBe('seed.apps.kortix.com');
  });

  test('keeps a path, which is part of what the App serves', () => {
    // Only a TRAILING slash is noise. `/docs` is the App.
    expect(appHost('https://seed.apps.kortix.com/docs')).toBe('seed.apps.kortix.com/docs');
  });

  test('leaves a value that carries no scheme alone', () => {
    expect(appHost('seed.apps.kortix.com')).toBe('seed.apps.kortix.com');
    expect(appHost('')).toBe('');
  });

  test('strips only the leading scheme, never one that appears later', () => {
    expect(appHost('https://seed.kortix.com/r?to=https://x.com')).toBe(
      'seed.kortix.com/r?to=https://x.com',
    );
  });
});

describe('deployment copy — pipeline vocabulary never reaches the reader', () => {
  const STATUSES = [
    'queued',
    'validating',
    'building',
    'provisioning',
    'checking',
    'ready',
    'failed',
    'cancelled',
  ] as const;

  test('every status has a label', () => {
    // A `Record` over the union, not an if-chain — a status added to the SDK
    // union fails the typecheck here rather than silently rendering blank.
    for (const status of STATUSES) {
      expect(DEPLOYMENT_COPY[status]?.label.length).toBeGreaterThan(0);
    }
  });

  test('the pipeline\'s own words for its steps never reach a label', () => {
    // These three are the build system describing itself. "Building" and
    // "Waiting" stay — they are ordinary English that happens to match a stage
    // name, which is the opposite problem.
    const JARGON = ['validating', 'provisioning', 'checking'];
    const labels = STATUSES.map((s) => DEPLOYMENT_COPY[s].label.toLowerCase());
    for (const word of JARGON) expect(labels).not.toContain(word);
  });

  test('tone follows outcome, not stage', () => {
    expect(DEPLOYMENT_COPY.ready.tone).toBe('success');
    expect(DEPLOYMENT_COPY.failed.tone).toBe('destructive');
    expect(DEPLOYMENT_COPY.cancelled.tone).toBe('muted');
    for (const status of ['queued', 'validating', 'building', 'provisioning', 'checking'] as const) {
      expect(DEPLOYMENT_COPY[status].tone).toBe('warning');
    }
  });
});

describe('deployNotice — the header speaks only when there is news', () => {
  const at = (status: (typeof DEPLOYMENT_COPY) extends never ? never : string) =>
    ({ status }) as unknown as Parameters<typeof deployNotice>[0];

  test('silent for the state almost every App is in almost always', () => {
    // A finished deployment is the resting state. A "Live" badge there would be
    // permanent chrome restating the green dot next to it.
    expect(deployNotice(at('ready'))).toBeNull();
    expect(deployNotice(undefined)).toBeNull();
    // Nothing is happening and nothing is broken.
    expect(deployNotice(at('cancelled'))).toBeNull();
  });

  test('one plain word for every in-flight stage, not five different ones', () => {
    // The header is read at a glance while using the App; `validating` versus
    // `provisioning` is not a distinction the reader can act on there. The
    // version list keeps the stage-by-stage detail.
    for (const status of ['queued', 'validating', 'building', 'provisioning', 'checking'] as const) {
      expect(deployNotice(at(status))).toEqual({ label: 'Updating', tone: 'warning' });
    }
  });

  test('a failure says what failed, in the reader’s terms', () => {
    expect(deployNotice(at('failed'))).toEqual({ label: 'Update failed', tone: 'destructive' });
  });
});

/**
 * The third defect: the gallery decided tile size for you, and chose wrong.
 *
 * It shipped a three-way size picker backed by `localStorage` — a preference
 * nobody holds until they have seen the page. The grid sizes itself now, and it
 * does so against its CONTAINER rather than the window: this page sits beside a
 * sidebar that docks and collapses, so ~256px of the grid's width appears and
 * disappears without the viewport moving at all.
 */
describe('APP_GRID_COLUMNS — the grid measures the box it is in', () => {
  /** The tile width `cols` columns leave inside a container of `width`. */
  const tile = (width: number, cols: number) => (width - 32 - (cols - 1) * 16) / cols;

  /** Which step the ladder resolves to at a given container width. */
  const columnsAt = (width: number) =>
    width >= 1024 ? 4 : width >= 768 ? 3 : width >= 512 ? 2 : 1;

  test('every step is a CONTAINER query, never a viewport breakpoint', () => {
    // `xl:grid-cols-4` on a 1280px viewport with the sidebar docked fires on a
    // container that is really ~1024px wide. The window is the wrong question.
    for (const viewportOnly of ['sm:', 'md:', 'lg:', 'xl:', '2xl:']) {
      expect(APP_GRID_COLUMNS).not.toContain(viewportOnly);
    }
    expect(APP_GRID_COLUMNS.match(/@\w+\/apps:/g)).toHaveLength(3);
  });

  test('the grid and its container name each other, or every step is inert', () => {
    // A `@lg/apps:` variant with no `@container/apps` ancestor compiles and
    // then never matches — the grid would silently stay one column forever.
    expect(APP_GRID_CONTAINER).toBe('@container/apps');
    const name = APP_GRID_CONTAINER.split('/')[1];
    for (const step of APP_GRID_COLUMNS.match(/@\w+\/\w+:/g) ?? []) {
      expect(step.split('/')[1]).toBe(`${name}:`);
    }
  });

  test('a docked desktop lands on four across', () => {
    // 1440px window minus a docked sidebar is a ~1184px container; the cap is
    // 1280px. Both are past the last step.
    expect(columnsAt(1184)).toBe(4);
    expect(columnsAt(1280)).toBe(4);
    expect(APP_GRID_COLUMNS).toContain('@5xl/apps:grid-cols-4');
  });

  test('a phone gets one column', () => {
    // Four columns of a 375px page is a 78px tile. One column is the floor and
    // the base class, so it needs no variant at all.
    expect(columnsAt(375)).toBe(1);
    expect(APP_GRID_COLUMNS.startsWith('grid-cols-1 ')).toBe(true);
  });

  test('no step ever produces a tile too small to read the App in', () => {
    // 230px is the width the 4:5 grid shipped at for one day: the App's whole
    // layout at ~18% scale, where every card is the same grey rectangle.
    for (const width of [375, 512, 640, 768, 900, 1024, 1184, 1280]) {
      const cols = columnsAt(width);
      if (cols === 1) continue;
      expect(tile(width, cols)).toBeGreaterThan(230);
    }
  });

  test('the ladder only ever widens, and names its classes in full', () => {
    const counts = [...(APP_GRID_COLUMNS.match(/grid-cols-(\d)/g) ?? [])].map((c) =>
      Number(c.replace('grid-cols-', '')),
    );
    expect(counts).toEqual([1, 2, 3, 4]);
    // Tailwind scans source text, so an interpolated class never reaches the
    // stylesheet.
    expect(APP_GRID_COLUMNS).not.toContain('${');
  });
});
