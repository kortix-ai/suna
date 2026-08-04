import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * `docs-page-actions.tsx` is the only place in the docs surface allowed to
 * dot into the client `Icon` namespace — see the RSC-boundary comments in
 * `page.tsx` and `layout.tsx`. This is a source-text contract (same approach
 * as `rsc-icon-boundary.test.ts` and `project-loading-contract.test.ts`)
 * rather than a render test, since rendering would need a full fumadocs +
 * next/navigation harness for no extra signal: what matters is which module
 * boundary each icon crosses.
 */
const WEB_ROOT = resolve(import.meta.dir, '../../..');
const ACTIONS = resolve(WEB_ROOT, 'src/app/docs/docs-page-actions.tsx');

describe('docs page actions', () => {
  const source = readFileSync(ACTIONS, 'utf8');

  test('is a client component', () => {
    const firstLine = source.split('\n').find((line) => line.trim().length > 0);
    expect(firstLine?.trim()).toBe("'use client';");
  });

  test('uses Icon.Github, not the RSC-safe GithubLogoIcon', () => {
    expect(source).toContain('Icon.Github');
    expect(source).not.toContain('GithubLogoIcon');
  });

  test('renders all six "Open" dropdown entries', () => {
    for (const label of [
      'Open in GitHub',
      'View as Markdown',
      'Open in ChatGPT',
      'Open in Claude',
      'Open in Cursor',
      'Open in Kortix',
    ]) {
      expect(source).toContain(label);
    }
  });

  test('builds the ChatGPT, Claude, Cursor and Kortix hrefs from the encoded prompt', () => {
    expect(source).toContain('https://chatgpt.com/?q=');
    expect(source).toContain('https://claude.ai/new?q=');
    expect(source).toContain('cursor://anysphere.cursor-deeplink/prompt?text=');
    expect(source).toContain('/projects/start?q=');
    expect(source).toContain('encodeURIComponent');
  });

  test('every external item opens in a new tab with rel="noreferrer noopener"', () => {
    // The six dropdown items render from one mapped array, so the anchor
    // attributes appear once in source for all six, plus once more for the
    // "Edit on GitHub" button's own anchor — two occurrences covering seven
    // links is the correct shape for this DRY implementation.
    const relMatches = source.match(/rel="noreferrer noopener"/g) ?? [];
    const blankMatches = source.match(/target="_blank"/g) ?? [];
    expect(relMatches.length).toBeGreaterThanOrEqual(2);
    expect(blankMatches.length).toBeGreaterThanOrEqual(2);

    // The mapped dropdown items and the standalone "Edit on GitHub" anchor
    // each carry their own rel/target pair.
    const openActionsBlock = source.slice(
      source.indexOf('openActions.map'),
      source.indexOf('</DropdownMenuContent>'),
    );
    expect(openActionsBlock).toContain('target="_blank"');
    expect(openActionsBlock).toContain('rel="noreferrer noopener"');

    const editButtonBlock = source.slice(source.indexOf('Edit on GitHub') - 400);
    expect(editButtonBlock).toContain('target="_blank"');
    expect(editButtonBlock).toContain('rel="noreferrer noopener"');
  });

  test('keeps the "Edit on GitHub" button, moved verbatim from page.tsx', () => {
    expect(source).toContain('Edit on GitHub');
    expect(source).toContain('variant="outline"');
    expect(source).toContain('size="sm"');
  });

  test('copies markdown to the clipboard and shows a transient "Copied" state', () => {
    expect(source).toContain('navigator.clipboard.writeText');
    expect(source).toContain('Copy Markdown');
    expect(source).toContain('Copied');
  });

  /**
   * Narrow viewports shorten the long labels and allow the row to wrap so the
   * three buttons never overflow the docs content column.
   */
  test('shortens labels below sm and allows the action row to wrap', () => {
    expect(source).toContain('flex-wrap');
    expect(source).toContain('sm:hidden');
    expect(source).toContain('hidden sm:inline');
    expect(source).toContain('>Copy</span>');
    expect(source).toContain('>Edit</span>');
  });

  /**
   * The requested shape: one `justify-between` row with Copy Markdown + Open
   * grouped at the left and Edit on GitHub pushed to the far right. Layout is
   * the easiest thing to regress without anyone noticing, so it is pinned by
   * position, not just by the presence of a class name.
   */
  test('lays the row out as justify-between with Edit on GitHub last', () => {
    expect(source).toContain('justify-between');

    const copyAt = source.indexOf('<CopyMarkdownButton');
    const dropdownAt = source.indexOf('<DropdownMenu>');
    const editAt = source.lastIndexOf('Edit on GitHub');

    expect(copyAt).toBeGreaterThan(-1);
    expect(dropdownAt).toBeGreaterThan(copyAt);
    expect(editAt).toBeGreaterThan(dropdownAt);
  });

  test('anchors the dropdown to the trigger start, since the trigger sits at the left edge', () => {
    expect(source).toContain('align="start"');
    expect(source).not.toContain('align="end"');
  });
});

describe('docs page renders the actions under the description', () => {
  const PAGE = resolve(WEB_ROOT, 'src/app/docs/[[...slug]]/page.tsx');

  /**
   * The actions act on the page the reader has just been introduced to, so they
   * sit under the title/description — not back up in the breadcrumb slot, which
   * is where they first landed.
   */
  test('mounts DocsPageActions between DocsDescription and DocsBody', () => {
    const source = readFileSync(PAGE, 'utf8');

    // Match the component tag even when it carries props (e.g. className).
    const descriptionAt = source.search(/<DocsDescription[\s>]/);
    const actionsAt = source.indexOf('<DocsPageActions');
    const bodyAt = source.indexOf('<DocsBody');

    expect(descriptionAt).toBeGreaterThan(-1);
    expect(actionsAt).toBeGreaterThan(descriptionAt);
    expect(bodyAt).toBeGreaterThan(actionsAt);
  });

  test('does not render the actions inside the breadcrumb slot', () => {
    const source = readFileSync(PAGE, 'utf8');
    const slotStart = source.indexOf('breadcrumb={{');
    const slotEnd = source.indexOf('<DocsTitle>');
    // Guard the markers themselves: if either moves, this test must fail loudly
    // rather than silently slice an empty string and assert nothing.
    expect(slotStart).toBeGreaterThan(-1);
    expect(slotEnd).toBeGreaterThan(slotStart);

    const breadcrumbSlot = source.slice(slotStart, slotEnd);

    // Match the JSX tag, not the bare name: this slot's own comment explains
    // where the actions moved TO, and a name-only assertion would fail that
    // comment. Same rule as files-route-contract.test.ts — constrain the
    // behaviour, not the vocabulary.
    expect(breadcrumbSlot).not.toContain('<DocsPageActions');
  });
});

describe('docs server entries never reference the client Icon namespace', () => {
  const PAGE = resolve(WEB_ROOT, 'src/app/docs/[[...slug]]/page.tsx');
  const LAYOUT = resolve(WEB_ROOT, 'src/app/docs/layout.tsx');

  test('page.tsx does not import or use the client Icon namespace', () => {
    const source = readFileSync(PAGE, 'utf8');
    // The warning comment itself mentions `Icon.Github` in backticks as an
    // example of what NOT to do — that mention must survive. What must never
    // appear is an actual import or JSX usage.
    expect(source).not.toMatch(/from\s+['"]@\/features\/icon\/icon['"]/);
    expect(source).not.toContain('<Icon.');
  });

  test('layout.tsx does not import or use the client Icon namespace', () => {
    const source = readFileSync(LAYOUT, 'utf8');
    expect(source).not.toMatch(/from\s+['"]@\/features\/icon\/icon['"]/);
    expect(source).not.toContain('<Icon.');
  });

  test('page.tsx keeps the RSC-icon-boundary warning comment intact', () => {
    const source = readFileSync(PAGE, 'utf8');
    expect(source).toContain("Server components must import icons from '@/lib/icons/ssr'");
  });

  test('layout.tsx keeps the RSC-icon-boundary warning comment intact', () => {
    const source = readFileSync(LAYOUT, 'utf8');
    expect(source).toContain("Server components must import icons from '@/lib/icons/ssr'");
  });
});
