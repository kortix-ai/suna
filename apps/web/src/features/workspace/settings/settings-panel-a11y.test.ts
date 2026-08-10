/**
 * Keyboard-activation invariant for the settings rail.
 *
 * Radix `Tabs` defaults to `activationMode="automatic"`, which SELECTS each tab
 * as arrow keys move over it. The rail has 28 entries and every pane fetches on
 * mount, so under the default, arrowing from Profile to the bottom of the rail
 * mounts every pane in between and fires each one's queries — a cost only
 * keyboard users pay. WAI-ARIA's guidance is manual activation whenever
 * selecting a tab has a side effect.
 *
 * This is asserted against the SOURCE rather than rendered markup on purpose:
 * `activationMode` is a React prop that Radix consumes internally and never
 * emits as a DOM attribute, so `renderToStaticMarkup` cannot see it. A prop
 * that silently reverts to a worse default is exactly the kind of regression
 * nothing else here would catch — the panel would still render, still pass
 * every markup test, and still typecheck.
 *
 * Same readFileSync approach as `components/iam/member-role-safety.test.ts`.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const RAW = readFileSync(join(import.meta.dir, 'settings-panel.tsx'), 'utf8');

/**
 * Comments are stripped before matching, and that is load-bearing rather than
 * tidy. The prop is documented by a block comment directly above it that quotes
 * `activationMode="manual"` verbatim — so asserting against the raw source made
 * the first check pass even with the real prop deleted. The comment was
 * satisfying the test. Caught only by deleting the prop and watching how many
 * assertions actually went red; a test you have never seen fail is a comment
 * that costs CPU.
 */
const PANEL = RAW.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('settings rail keyboard activation', () => {
  test('the Tabs root opts into manual activation', () => {
    expect(PANEL).toContain('activationMode="manual"');
  });

  test('the assertion above reads code, not the comment documenting it', () => {
    // Guards the stripping itself: if `PANEL` ever stops removing comments, the
    // check above silently becomes unfalsifiable again.
    expect(RAW).toContain('WAI-ARIA');
    expect(PANEL).not.toContain('WAI-ARIA');
  });

  test('it is set on the vertical rail root, not some nested Tabs', () => {
    // The rail root is the one carrying `orientation="vertical"`. Pin them as
    // adjacent props so moving `activationMode` onto an inner Tabs (the LLM
    // gateway sub-tabs, say) fails rather than quietly passing.
    expect(PANEL).toMatch(/orientation="vertical"\s*\n\s*activationMode="manual"/);
  });

  test('automatic activation is never re-introduced', () => {
    expect(PANEL).not.toContain('activationMode="automatic"');
  });
});
