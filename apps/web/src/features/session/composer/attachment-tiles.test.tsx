import {
  ApiError,
  BillingError,
  configureKortix,
  createPromptAttachmentController,
  type PromptAttachmentItem,
  type PromptAttachmentStatus,
} from '@kortix/sdk';
import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import { createTranslator } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';

import deMessages from '../../../../translations/de.json';

import { TILE_SURFACE } from '../attachment-tile';
import { AttachmentTiles, attachmentTileCopy, subscribeWhenDue } from './attachment-tiles';
import type { AttachedFile } from './types';

/**
 * `renderToStaticMarkup` never commits effects, so the HEIC-decode and
 * text-preview `useEffect`s in `attachment-tiles.tsx` never run here — these
 * assertions cover the synchronous shape: the sent message's own tile
 * surfaces, two-line-clamped filenames, a positioning anchor the remove
 * button can actually use, and the always-reachable remove button. The
 * effect itself (HEIC conversion) is exercised indirectly via
 * `attachment-tiles-logic.test.ts`, which covers its pure decision logic.
 */

const localImage = (name: string, localUrl = 'blob:local-1'): AttachedFile => ({
  kind: 'local',
  file: new File([''], name, { type: 'image/png' }),
  localUrl,
  isImage: true,
});

const localDoc = (name: string): AttachedFile => ({
  kind: 'local',
  file: new File(['hello'], name, { type: 'application/pdf' }),
  localUrl: 'blob:local-doc',
  isImage: false,
});

/** Every `class="..."` attribute value in a markup string. */
function classAttrs(html: string): string[] {
  return [...html.matchAll(/class="([^"]*)"/g)].map((m) => m[1]);
}

/** The composer attached `a.png` at this instant. Each render sets the fake clock. */
const ATTACHED_AT = 1_700_000_000_000;

const pngFile = new File(['0123456789'], 'a.png', { type: 'image/png' });
const uploadingImage: AttachedFile = {
  kind: 'local',
  uploadId: 'up-a',
  file: pngFile,
  localUrl: 'blob:a',
  isImage: true,
  attachedAt: ATTACHED_AT,
};

const uploadOf = (
  status: PromptAttachmentStatus,
  patch: Partial<PromptAttachmentItem> = {},
): PromptAttachmentItem => ({
  id: 'up-a',
  file: pngFile,
  filename: 'a.png',
  mime: 'image/png',
  size: 10,
  status,
  receivedBytes: status === 'uploading' ? 5 : status === 'pending' ? 0 : 10,
  ...patch,
});

/** Render the tray with the fake clock `elapsedMs` after the attach. */
function trayAt(
  elapsedMs: number,
  files: AttachedFile[],
  uploads: readonly PromptAttachmentItem[],
): string {
  setSystemTime(new Date(ATTACHED_AT + elapsedMs));
  return renderToStaticMarkup(
    <AttachmentTiles files={files} uploads={uploads} onRemove={() => {}} onRetry={() => {}} />,
  );
}

/** One composer tile unit: from its box `<div>` up to the closing `</li>`. */
function tileUnit(markup: string): string {
  const start = markup.indexOf('<div');
  return markup.slice(start, markup.indexOf('</li>', start));
}

/** The opening tag of the progress ring slot, or `''`. */
function ringTag(markup: string): string {
  return markup.match(/<span[^>]*data-slot="upload-ring"[^>]*>/)?.[0] ?? '';
}

afterEach(() => {
  setSystemTime();
});

describe('subscribeWhenDue', () => {
  /** Timers the test fires by hand, early or on time, against a clock it sets. */
  function manualTimers() {
    let now = 0;
    let nextHandle = 0;
    const pending = new Map<number, () => void>();
    const cleared: unknown[] = [];
    return {
      timers: {
        now: () => now,
        set: (callback: () => void) => {
          const handle = ++nextHandle;
          pending.set(handle, callback);
          return handle;
        },
        clear: (handle: unknown) => {
          cleared.push(handle);
          pending.delete(handle as number);
        },
      },
      setNow: (value: number) => {
        now = value;
      },
      fire: () => {
        const callbacks = [...pending.values()];
        pending.clear();
        for (const run of callbacks) run();
      },
      pending: () => pending.size,
      cleared,
    };
  }

  test('notifies once at the due time, and re-arms when a timer fires early', () => {
    const clock = manualTimers();
    let notified = 0;
    subscribeWhenDue(400, clock.timers)(() => {
      notified += 1;
    });
    expect(clock.pending()).toBe(1);

    // A browser fires the 400 ms timer 1 ms early against `Date.now()`.
    clock.setNow(399);
    clock.fire();
    expect(notified).toBe(0);
    expect(clock.pending()).toBe(1);

    clock.setNow(400);
    clock.fire();
    expect(notified).toBe(1);
    expect(clock.pending()).toBe(0);
  });

  test('unsubscribe clears the pending timer', () => {
    const clock = manualTimers();
    const unsubscribe = subscribeWhenDue(400, clock.timers)(() => {});
    unsubscribe();
    expect(clock.pending()).toBe(0);
    expect(clock.cleared).toHaveLength(1);
  });
});

describe('AttachmentTiles', () => {
  test('an uploading tile is busy and draws a determinate ring, with no status text', () => {
    const uploading = trayAt(400, [uploadingImage], [uploadOf('uploading')]);
    expect(uploading).toContain('src="blob:a"');
    expect(uploading).toContain('aria-busy="true"');
    expect(ringTag(uploading)).toContain('role="progressbar"');
    expect(ringTag(uploading)).toContain('aria-valuenow="50"');
    const processing = trayAt(400, [uploadingImage], [uploadOf('processing')]);
    expect(ringTag(processing)).toContain('aria-valuenow="100"');
    const pending = trayAt(400, [uploadingImage], [uploadOf('pending')]);
    expect(ringTag(pending)).toContain('aria-valuenow="0"');
    for (const markup of [uploading, processing, pending]) {
      expect(markup).not.toMatch(/Uploading|Processing|Waiting|\d ?%/);
      expect(markup).not.toContain('role="status"');
      expect(markup).not.toContain('tabular-nums');
      expect(markup).not.toContain('animate-spinner-orbit');
    }
  });

  test('the ring renders only when the upload still runs 400 ms after attach', () => {
    const early = trayAt(399, [uploadingImage], [uploadOf('uploading')]);
    expect(early).toContain('src="blob:a"');
    expect(early).toContain('aria-busy="true"');
    expect(ringTag(early)).toBe('');
    expect(early).not.toContain('role="progressbar"');
    const late = trayAt(400, [uploadingImage], [uploadOf('uploading')]);
    expect(ringTag(late)).toContain('role="progressbar"');
    // A file ready inside 400 ms never shows upload chrome.
    expect(ringTag(trayAt(399, [uploadingImage], [uploadOf('ready')]))).toBe('');
  });

  test('pending to ready keeps one tile box: the ring fades out inside it, no sibling rows', () => {
    const states = (['pending', 'uploading', 'processing', 'ready'] as const).map((status) =>
      trayAt(400, [uploadingImage], [uploadOf(status)]),
    );
    const outer = states.map((markup) => classAttrs(tileUnit(markup)).slice(0, 2));
    for (const classes of outer) expect(classes).toEqual(['group relative', TILE_SURFACE]);
    for (const markup of states) {
      // The tile, its remove control, and an empty live region. Nothing else.
      expect(tileUnit(markup)).toMatch(
        /<\/button><span class="sr-only" aria-live="polite"><\/span><\/div>$/,
      );
      expect(markup).not.toMatch(/\bmt-1\b|min-h-5/);
    }
    expect(ringTag(states[1]!)).toContain('opacity-100');
    expect(ringTag(states[1]!)).toContain('transition-opacity');
    expect(ringTag(states[1]!)).toContain('duration-(--duration-moderate)');
    const ready = states[3]!;
    expect(ready).not.toContain('aria-busy');
    expect(ready).not.toContain('role="progressbar"');
    expect(ringTag(ready)).toContain('aria-hidden="true"');
    expect(ringTag(ready)).toContain('opacity-0');
  });

  test('a failed tile keeps its picture under a scrim with one retry icon button, remove, and one announcement', () => {
    const markup = trayAt(
      5_000,
      [uploadingImage],
      [uploadOf('error', { error: new Error('network unavailable') })],
    );
    expect(markup).toContain('src="blob:a"');
    expect(markup).toContain('bg-background/70');
    expect(markup.match(/aria-label="Retry upload of a\.png"/g)).toHaveLength(1);
    const retry = markup.match(/<button[^>]*aria-label="Retry upload of a\.png"[^>]*>/)?.[0] ?? '';
    expect(retry).toContain('size-7');
    expect(retry).not.toMatch(/h-auto|px-1\.5|py-0\.5|text-xs/);
    expect(markup).toContain('aria-label="Remove a.png"');
    expect(markup).toContain(
      '<span class="sr-only" aria-live="polite">a.png did not upload.</span>',
    );
    expect(markup).not.toContain('aria-busy');
    expect(markup).not.toContain('role="progressbar"');
    expect(markup).not.toContain('role="alert"');
    // The SDK message is English; the tooltip carries the localized reason instead.
    expect(markup).not.toContain('network unavailable');
  });

  test('an id a submission holds has no remove control; a listed upload keeps it while uploading (M3)', () => {
    const heldFile = new File(['x'], 'held.png', { type: 'image/png' });
    const held: AttachedFile = {
      kind: 'local',
      uploadId: 'held-1',
      file: heldFile,
      localUrl: 'blob:held',
      isImage: true,
      attachedAt: ATTACHED_AT,
    };
    const markup = trayAt(400, [held, uploadingImage], [uploadOf('uploading')]);
    expect(markup).toContain('src="blob:held"');
    expect(markup).not.toContain('aria-label="Remove held.png"');
    expect(markup).toContain('aria-label="Remove a.png"');
  });

  test('M3 through the real SDK controller: submit() unlists the id, so its tile loses remove', () => {
    configureKortix({
      backendUrl: 'https://api.test',
      getToken: async () => 'token',
      fetch: async () => new Promise<Response>(() => {}),
    });
    const controller = createPromptAttachmentController('project-1');
    const file = new File(['png'], 'held.png', { type: 'image/png' });
    const [id] = controller.addMany([file]);
    const tray: AttachedFile[] = [
      {
        kind: 'local',
        uploadId: id!,
        file,
        localUrl: 'blob:held',
        isImage: true,
        attachedAt: ATTACHED_AT,
      },
    ];
    expect(trayAt(400, tray, controller.getSnapshot().attachments)).toContain(
      'aria-label="Remove held.png"',
    );
    controller.submit([id!]);
    const held = trayAt(400, tray, controller.getSnapshot().attachments);
    expect(held).toContain('src="blob:held"');
    expect(held).not.toContain('aria-label="Remove held.png"');
    controller.dispose();
  });

  test('a failed connection upload keeps Retry; no native title sits under the scrim', () => {
    const markup = trayAt(
      5_000,
      [uploadingImage],
      [uploadOf('error', { error: new ApiError('Network error', { name: 'TypeError' }) })],
    );
    expect(markup).toContain('aria-label="Retry upload of a.png"');
    expect(markup).toContain('<span class="sr-only">Upload failed. Check your connection.</span>');
    // The tooltip on the scrim carries the reason. A `title` on the tile would add a second,
    // native tooltip over the same spot.
    expect(tileUnit(markup)).not.toContain('title=');
  });

  test('a refusal Retry cannot fix states its reason and offers only Remove', () => {
    const refusals: Array<[Error, string]> = [
      [
        new BillingError(402, { message: 'Payment required' }),
        'Your plan or credits do not allow uploads right now.',
      ],
      [
        new ApiError('Unsent attachments are limited', {
          status: 429,
          code: 'attachment_budget_exceeded',
        }),
        'Too many unsent uploads. Unused uploads expire within 24 hours.',
      ],
      [
        new ApiError('Each attachment must contain 1 byte to 50 MiB.', {
          status: 413,
          code: 'attachment_size_limit',
        }),
        'This file is larger than 50 MiB.',
      ],
      [
        new ApiError('Attachment expired. Attach the file again.', { code: 'attachment_expired' }),
        'This upload expired. Remove it and attach the file again.',
      ],
    ];
    for (const [error, reason] of refusals) {
      const markup = trayAt(5_000, [uploadingImage], [uploadOf('error', { error })]);
      expect(markup).toContain(`<span class="sr-only">${reason}</span>`);
      expect(markup).not.toContain('Retry upload of a.png');
      expect(markup).toContain('aria-label="Remove a.png"');
      expect(markup).toContain('bg-background/70');
    }
  });

  test('renders the failure reason, retry label, and announcement in the active locale', () => {
    const translator = createTranslator({
      locale: 'de',
      messages: deMessages,
      namespace: 'hardcodedUi.composerAttachments',
    });
    const copy = attachmentTileCopy(translator);

    expect(Object.keys(copy).sort()).toEqual([
      'didNotUpload',
      'failureReason',
      'retryNamed',
      'uploadFailed',
    ]);
    expect(copy.failureReason('billing')).toBe(
      'Ihr Tarif oder Guthaben erlaubt derzeit keine Uploads.',
    );
    expect(copy.failureReason('connection')).toBe(
      'Upload fehlgeschlagen. Prüfen Sie Ihre Verbindung.',
    );
    expect(copy.uploadFailed).toBe('Upload fehlgeschlagen. Prüfen Sie Ihre Verbindung.');
    expect(copy.retryNamed('fehler.pdf')).toBe('Upload von fehler.pdf erneut versuchen');
    expect(copy.didNotUpload('fehler.pdf')).toBe('fehler.pdf wurde nicht hochgeladen.');
  });

  test('an attached SVG shows its name, not a rendered preview', () => {
    const svg: AttachedFile = {
      kind: 'local',
      file: new File(['<svg/>'], 'Jay Suthar.svg', { type: 'image/svg+xml' }),
      localUrl: 'blob:local-svg',
      isImage: true,
    };
    const markup = renderToStaticMarkup(<AttachmentTiles files={[svg]} onRemove={() => {}} />);
    expect(markup).not.toContain('<img');
    expect(markup).toContain('Jay Suthar.svg');
    expect(markup).toMatch(/>svg</);
  });

  test('no files renders nothing', () => {
    expect(renderToStaticMarkup(<AttachmentTiles files={[]} onRemove={() => {}} />)).toBe('');
  });

  test('an image tile paints the picture, not a filename tile', () => {
    const markup = renderToStaticMarkup(
      <AttachmentTiles files={[localImage('photo.png')]} onRemove={() => {}} />,
    );
    expect(markup).toContain('src="blob:local-1"');
    expect(markup).toContain('alt="photo.png"');
  });

  test('a non-image tile shows the name + extension badge treatment', () => {
    const markup = renderToStaticMarkup(
      <AttachmentTiles files={[localDoc('AdmitCard-260411128971.pdf')]} onRemove={() => {}} />,
    );
    // A long name is an ellipsized head plus its verbatim ten-character tail,
    // and the badge names the type. `title=` and `aria-label=` carry the full
    // name.
    expect(markup).toMatch(/class="block truncate">128971\.pdf</);
    expect(markup).toMatch(/>pdf</);
    expect(markup).toContain('size-28');
    expect(markup).toContain('min-w-0');
  });

  test('image and file tiles are ONE square — the same surface the sent message uses', () => {
    // A PDF used to render as an 80×80 square while composing and a wider
    // rectangle once sent — the exact drift this module exists to eliminate.
    // Now there is one shape, taken from the shared module rather than pasted.
    const image = renderToStaticMarkup(
      <AttachmentTiles files={[localImage('photo.png')]} onRemove={() => {}} />,
    );
    const doc = renderToStaticMarkup(
      <AttachmentTiles files={[localDoc('notes.txt')]} onRemove={() => {}} />,
    );
    expect(image).toContain(TILE_SURFACE);
    expect(doc).toContain(TILE_SURFACE);
    expect(image).not.toContain('w-30');
    expect(doc).not.toContain('w-30');
  });

  test('remove button is hidden until the tile is hovered, yet reachable without hover', () => {
    const markup = renderToStaticMarkup(
      <AttachmentTiles files={[localDoc('notes.txt')]} onRemove={() => {}} />,
    );
    expect(markup).toContain('aria-label="Remove notes.txt"');
    const button = markup.slice(markup.indexOf('<button'), markup.indexOf('</button>'));
    // Invisible at rest, shown by hovering the tile…
    expect(button).toContain('opacity-0');
    expect(button).toContain('group-hover:opacity-100');
    expect(button).not.toContain('opacity-60');
    // …and still there for keyboard focus and for touch, where hover does not exist.
    expect(button).toContain('focus-visible:opacity-100');
    expect(button).toContain('[@media(pointer:coarse)]:opacity-100');
  });

  test('multiple attachments each get their own remove button', () => {
    const markup = renderToStaticMarkup(
      <AttachmentTiles
        files={[localDoc('a.txt'), localImage('b.png'), localDoc('c.pdf')]}
        onRemove={() => {}}
      />,
    );
    expect(markup).toContain('aria-label="Remove a.txt"');
    expect(markup).toContain('aria-label="Remove b.png"');
    expect(markup).toContain('aria-label="Remove c.pdf"');
  });

  test('the tile has no cursor-pointer / press-scale affordance (nothing to click)', () => {
    // TILE_INTERACTIVE ships `cursor-pointer` + `active:scale-[0.96]` — a
    // click promise. The composer tile has no click handler, so applying it
    // unconditionally (as an earlier version of this component did) would be
    // a broken promise, unlike the sent message's `canOpen && TILE_INTERACTIVE`
    // (`user-message.tsx`), which only offers it when there is something to
    // open.
    const markup = renderToStaticMarkup(
      <AttachmentTiles
        files={[localDoc('notes.txt'), localImage('photo.png')]}
        onRemove={() => {}}
      />,
    );
    expect(markup).not.toContain('cursor-pointer');
    expect(markup).not.toContain('active:scale-[0.96]');
  });

  test('no element is both `contents` and `relative` — that combination is inert', () => {
    // `display: contents` removes an element's own box; an element with no
    // box cannot anchor `position: absolute` children. A `<li>` that was
    // `"group relative contents"` looked like a positioning anchor and
    // wasn't one — the remove button silently anchored to whatever real
    // positioned ancestor existed further up instead of its own tile.
    const markup = renderToStaticMarkup(
      <AttachmentTiles files={[localDoc('notes.txt')]} onRemove={() => {}} />,
    );
    for (const cls of classAttrs(markup)) {
      const words = cls.split(/\s+/);
      const hasBoth = words.includes('contents') && words.includes('relative');
      expect(hasBoth).toBe(false);
    }
  });

  test('the remove button is not nested inside the overflow-hidden tile (would clip its corner)', () => {
    // The tile box is `overflow-hidden` (to clip the image/icon to its
    // rounded corners). The remove button's `-top-1.5 -right-1.5` offset
    // puts part of it outside that box's edge on purpose — nesting the
    // button inside an `overflow-hidden` ancestor would silently chop that
    // part off. Confirm the tile div fully closes before the button opens,
    // i.e. they are siblings, not parent/child.
    const markup = renderToStaticMarkup(
      <AttachmentTiles files={[localDoc('notes.txt')]} onRemove={() => {}} />,
    );
    const tileStart = markup.indexOf('overflow-hidden');
    const buttonOpens = markup.indexOf('<button');
    expect(tileStart).toBeGreaterThan(-1);
    expect(buttonOpens).toBeGreaterThan(tileStart);
    // Every element opened from the tile onward is closed again before the
    // button opens — the tile is a finished sibling, not an open ancestor.
    const between = markup.slice(tileStart, buttonOpens);
    const opens = (between.match(/<span\b/g) ?? []).length;
    const closes = (between.match(/<\/span>/g) ?? []).length;
    expect(closes).toBe(opens + 1); // +1: the tile's own opening tag sits before `tileStart`
  });
});
