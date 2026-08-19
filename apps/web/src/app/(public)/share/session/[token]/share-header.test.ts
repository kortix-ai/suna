import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const page = readFileSync(resolve(import.meta.dir, 'page.tsx'), 'utf8');
const view = readFileSync(resolve(import.meta.dir, 'public-file-share-view.tsx'), 'utf8');
const root = readFileSync(resolve(import.meta.dir, 'share-layout.ts'), 'utf8');

// Anti-vacuity guard: every `not.toContain` below would pass on an empty
// string, so prove first that both files were actually read.
describe('public share sources are loaded', () => {
  test('page and file view sources are non-empty and are the expected modules', () => {
    expect(page).toContain('export default function PublicSessionSharePage');
    expect(view).toContain('export function PublicFileShareView');
  });
});

describe('public share header chrome', () => {
  test('identity is the Kortix logo plus the file name only', () => {
    expect(page).toContain('KortixLogo');
    // The title comes from the file name, never the workspace path.
    expect(page).toContain('fileNameFromPath');
    expect(page).toContain('const title = isFileShare ? fileName : meta.share.label');
  });

  test('header controls carry no ad-hoc sizing or press effects', () => {
    const header = page.slice(page.indexOf('<header'), page.indexOf('</header>'));
    // Button owns its own height, gap and icon size through `size`/`variant`.
    // Re-specifying them here is how a toolbar drifts out of the system.
    expect(header).not.toContain('active:scale');
    expect(header).not.toContain('h-8');
    expect(header).not.toContain('size-3.5');
  });

  test('the removed share-meta labels stay removed', () => {
    // 'Public share' eyebrow, share-type caption, and permission line.
    expect(page).not.toContain('autoAppPublicShareSessionTokenPageJsxTextPublicSharedbc2d952');
    expect(page).not.toContain('File share');
    expect(page).not.toContain('Preview share');
    expect(page).not.toContain('No terminal, files, or session controls');
    expect(page).not.toContain('View only');
  });

  test('Download and Full screen sit in the header next to Open in Kortix', () => {
    const header = page.slice(page.indexOf('<header'), page.indexOf('</header>'));
    expect(header).toContain('Download');
    expect(header).toContain('Full screen');
    // 'Open in Kortix'
    expect(header).toContain('autoAppPublicShareSessionTokenPageJsxTextOpenIn2fdbf464');
  });

  test('full screen hides the header and offers a way back out', () => {
    expect(page).toContain('{!fullscreen && (');
    expect(page).toContain('Exit full screen');
    // Escape is a convenience only; focus inside the iframe never reaches it,
    // so the visible exit control must not be conditioned on hover/focus.
    expect(page).toContain("event.key === 'Escape'");
  });
});

describe('public share content pane', () => {
  test('the pane clips its own radius, and canvas and sheet are different tones', () => {
    const start = page.indexOf('<section');
    const section = page.slice(start, page.indexOf('>', start));
    // Anti-vacuity guard: prove the slice is the content region.
    expect(section).toContain('flex-1');
    expect(section).toContain('rounded-t-md');
    // Without a clip the iframe paints its square background straight over the
    // corners and the radius is invisible.
    expect(section).toContain('overflow-clip');
    // And the corner notch needs a different tone behind it to be seen at all.
    expect(section).toContain('bg-background');
    expect(root).toContain('bg-card');
  });
});

describe('public file share view', () => {
  test('renders no second header: no breadcrumbs, no VIEW ONLY badge, no duplicate download', () => {
    expect(view).toContain('showHeader={false}');
    expect(view).not.toContain('Breadcrumbs:');
    expect(view).not.toContain('PublicFileBreadcrumbs');
  });

  test('stays read-only', () => {
    expect(view).toContain('readOnly');
    expect(view).toContain('Public file shares are read-only');
  });
});
