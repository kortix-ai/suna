import { describe, expect, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { DriveNewMenuItems, DriveToolbar, hasWriteActions } from './drive-toolbar';

/**
 * `apps/web` has no jsdom/happy-dom and no `@testing-library/react` (see
 * `members-tab.test.tsx`), so these render statically. That is enough for the
 * defect under test: the explorer shipped with `handleUpload`,
 * `setIsCreatingFile(true)` and `setIsCreatingFolder(true)` referenced by NO
 * control at all, so drag-and-drop was the only way to get a file in.
 *
 * The menu's own entries live in `DriveNewMenuItems` — injectable exactly like
 * `FolderDriveMenuItems` — so they can be rendered and driven without a live
 * Radix portal (portal content is absent from static markup).
 */
function renderToolbar(props: Partial<Parameters<typeof DriveToolbar>[0]> = {}) {
  // Every label under test is literal English in the component. next-intl only
  // supplies `title`/placeholder copy here, so missing-message and
  // server-render fallbacks are swallowed rather than dragging a 644 KB
  // catalogue into the run.
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={{}} onError={() => {}}>
      <DriveToolbar onDownloadDir={() => {}} onRefresh={() => {}} {...props} />
    </NextIntlClientProvider>,
  );
}

describe('DriveToolbar write actions', () => {
  test('a writable source gets a New menu trigger in the toolbar', () => {
    const html = renderToolbar({
      onUpload: () => {},
      onNewFile: () => {},
      onNewFolder: () => {},
    });
    expect(html).toContain('>New</button>');
  });

  test('a read-only source sees no write control', () => {
    const html = renderToolbar();
    expect(html).not.toContain('>New</button>');
    // The read-only toolbar still renders — this is not an empty-string pass.
    expect(html).toContain('workspace');
  });

  test('the gate needs all three handlers — a half-wired menu never renders', () => {
    const noop = () => {};
    expect(hasWriteActions({ onUpload: noop, onNewFile: noop, onNewFolder: noop })).toBe(true);
    expect(hasWriteActions({ onUpload: noop, onNewFile: noop })).toBe(false);
    expect(hasWriteActions({ onUpload: noop })).toBe(false);
    expect(hasWriteActions({})).toBe(false);
    expect(renderToolbar({ onUpload: () => {} })).not.toContain('>New</button>');
  });
});

describe('DriveNewMenuItems', () => {
  /** Captures each entry's label and onClick as the menu renders. */
  function renderMenu(handlers: {
    onUpload?: () => void;
    onNewFile?: () => void;
    onNewFolder?: () => void;
  }) {
    const entries: Array<{ onClick?: () => void }> = [];
    const Item = ({ onClick, children }: { onClick?: () => void; children: ReactNode }) => {
      entries.push({ onClick });
      return <div>{children}</div>;
    };
    const Separator = () => <hr />;
    const html = renderToStaticMarkup(
      <DriveNewMenuItems Item={Item} Separator={Separator} {...handlers} />,
    );
    return { entries, html };
  }

  test('offers upload, new file, and new folder', () => {
    const { html, entries } = renderMenu({});
    expect(html).toContain('Upload files');
    expect(html).toContain('New file');
    expect(html).toContain('New folder');
    expect(entries).toHaveLength(3);
  });

  test('each entry fires its OWN handler', () => {
    const fired: string[] = [];
    const { entries } = renderMenu({
      onUpload: () => fired.push('upload'),
      onNewFile: () => fired.push('new-file'),
      onNewFolder: () => fired.push('new-folder'),
    });

    entries[0].onClick?.();
    entries[1].onClick?.();
    entries[2].onClick?.();

    expect(fired).toEqual(['upload', 'new-file', 'new-folder']);
  });
});
