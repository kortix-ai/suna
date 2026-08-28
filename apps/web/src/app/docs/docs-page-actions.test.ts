import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * `docs-page-actions.tsx` is the only place in the docs surface allowed to
 * use the client-only brand icons (Github, ChatGPT, Claude, Cursor, Kortix,
 * from `@/features/icon/icons/*`) instead of the RSC-safe set in
 * `@/lib/icons/ssr` — see the RSC-boundary comments in `page.tsx` and
 * `layout.tsx`. This is a source-text contract (same approach as
 * `project-loading-contract.test.ts`) rather than a render test, since
 * rendering would need a full fumadocs + next/navigation harness for no
 * extra signal: what matters is which module boundary each icon crosses.
 */
const WEB_ROOT = resolve(import.meta.dir, '../../..');
const ACTIONS = resolve(WEB_ROOT, 'src/app/docs/docs-page-actions.tsx');

/**
 * Comments in `docs-page-actions.tsx` legitimately name the things the
 * negative assertions below forbid — the "Copied" label the icon replaced,
 * the `@/lib/icons/ssr` module it must not import from. Strip them so those
 * tests constrain the code and not the prose about it (the same rule the
 * breadcrumb test at the bottom of this file follows).
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

describe('docs page actions', () => {
  const source = readFileSync(ACTIONS, 'utf8');
  const code = stripComments(source);

  test('is a client component', () => {
    const firstLine = source.split('\n').find((line) => line.trim().length > 0);
    expect(firstLine?.trim()).toBe("'use client';");
  });

  test('uses the client Github icon, not the RSC-safe GithubLogoIcon', () => {
    expect(source).toContain("from '@/features/icon/icons/github'");
    expect(source).toContain('<Github');
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

  test('copies markdown to the clipboard and confirms with the icon, not a label swap', () => {
    expect(source).toContain('navigator.clipboard.writeText');

    // The label is fixed for the whole cycle — both the wide and the narrow
    // form. Swapping it to "Copied" resized the button and shoved the "Open"
    // trigger sideways for two seconds.
    expect(source).toContain('Copy Markdown');
    expect(source).toContain('>Copy</span>');

    // The word only survives on `aria-label`, lower-cased. A capital-C
    // "Copied" anywhere in this file means the visible label swap is back.
    // (`COPIED_RESET_MS` is all-caps, so it does not trip this.)
    expect(code).not.toContain('Copied');
    expect(code).toContain("aria-label={copied ? 'Markdown copied' : 'Copy markdown'}");
  });

  /**
   * The design system bans the hard `{copied ? <Check/> : <Copy/>}` swap:
   * both glyphs share one fixed box and cross-fade with blur + scale +
   * opacity, exactly as `components/markdown/copy-button.tsx` does for code
   * blocks. Pinned by the transition's own values, since a regression here
   * looks identical in a screenshot and only shows up in motion.
   */
  test('cross-fades the copy and check icons instead of hard-swapping them', () => {
    expect(source).toContain("import { AnimatePresence, m } from 'motion/react';");
    expect(source).toContain("key={copied ? 'check' : 'copy'}");
    expect(source).toContain("scale: 0.25, opacity: 0, filter: 'blur(4px)'");
    expect(source).toContain("scale: 1, opacity: 1, filter: 'blur(0px)'");
    expect(source).toContain("type: 'spring', duration: 0.3, bounce: 0");
    // Nothing animates on first paint.
    expect(source).toContain('initial={false}');
  });

  /**
   * `@/lib/icons/ssr` exists for React Server Components, which cannot read
   * context and so need the weight pre-bound. This file is 'use client', so
   * its icons must come from the main entry and stay wired to `IconProvider`.
   */
  test('takes CheckIcon from the client Phosphor entry, not the RSC-only module', () => {
    expect(code).toContain('<CheckIcon');
    expect(code).not.toContain('@/lib/icons/ssr');

    const importBlock = code.slice(0, code.indexOf('type OpenAction'));
    expect(importBlock).toContain('CheckIcon,');
    expect(importBlock).toContain("} from '@phosphor-icons/react';");
  });

  /**
   * `size="sm"` reaches its tighter `px-2.5` through `has-[>svg]:px-2.5`,
   * which stopped matching once the icon moved inside the crossfade wrapper.
   * Without the explicit class this button sits a notch wider than the two
   * beside it.
   */
  test('restores the icon-button padding the crossfade wrapper broke', () => {
    const buttonBlock = source.slice(source.indexOf('function CopyMarkdownButton'));
    expect(buttonBlock).toContain("'shrink-0 gap-1.5 px-2.5'");
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

// A prior `describe('docs server entries never reference the client Icon
// namespace', …)` lived here. It scanned page.tsx/layout.tsx for imports of
// `@/features/icon/icon` and pinned the warning comment's exact wording. That
// module is deleted (see rsc-icon-boundary.test.ts's removal) and cannot be
// reintroduced without recreating the whole barrel object it named, so the
// scan was permanently vacuous — every icon is now its own named export, and
// a Server Component importing one directly gets a real client reference,
// not a namespace stub read as `undefined`. Removed rather than kept as a
// green check with nothing left to catch.
