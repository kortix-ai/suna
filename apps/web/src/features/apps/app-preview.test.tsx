import { describe, expect, jest, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { stripTags } from '@/test-utils/strip-tags';
import type { App } from '@kortix/sdk';

import {
  AppPreview,
  AppPreviewOverlay,
  PREVIEW_SPINNER_DELAY_MS,
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
