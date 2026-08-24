import { describe, expect, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { DriveNewMenu, DriveNewMenuItems, DrivePathBar, hasWriteActions } from './drive-toolbar';

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
function render(node: ReactNode) {
  // Every label under test is literal English in the component. next-intl only
  // supplies `title`/placeholder copy here, so missing-message and
  // server-render fallbacks are swallowed rather than dragging a 644 KB
  // catalogue into the run.
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={{}} onError={() => {}}>
      {node}
    </NextIntlClientProvider>,
  );
}

describe('DriveNewMenu write actions', () => {
  test('a writable source gets a New menu trigger', () => {
    const html = render(
      <DriveNewMenu onUpload={() => {}} onNewFile={() => {}} onNewFolder={() => {}} />,
    );
    expect(html).toContain('>New</button>');
  });

  test('a read-only source sees no write control at all', () => {
    expect(render(<DriveNewMenu />)).toBe('');
  });

  test('the gate needs all three handlers — a half-wired menu never renders', () => {
    const noop = () => {};
    expect(hasWriteActions({ onUpload: noop, onNewFile: noop, onNewFolder: noop })).toBe(true);
    expect(hasWriteActions({ onUpload: noop, onNewFile: noop })).toBe(false);
    expect(hasWriteActions({ onUpload: noop })).toBe(false);
    expect(hasWriteActions({})).toBe(false);
    expect(render(<DriveNewMenu onUpload={() => {}} />)).toBe('');
  });

  test('the compact trigger keeps an accessible name once the label is gone', () => {
    const html = render(
      <DriveNewMenu compact onUpload={() => {}} onNewFile={() => {}} onNewFolder={() => {}} />,
    );
    expect(html).toContain('aria-label="New"');
    expect(html).not.toContain('>New</button>');
  });
});

describe('DrivePathBar', () => {
  test('inline mode always shows a root crumb, and takes the host label', () => {
    expect(render(<DrivePathBar />)).toContain('workspace');
    expect(render(<DrivePathBar rootLabel="Files" />)).toContain('Files');
  });

  /**
   * The whole reason the strip is separable: at the root it has nothing to
   * say, and a bordered bar carrying one word is exactly the chrome this
   * redesign removed. `/workspace` IS the root.
   */
  test('row mode renders nothing at the root', () => {
    expect(render(<DrivePathBar as="row" />)).toBe('');
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
