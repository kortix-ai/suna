/**
 * Regression pin: the LIVE session surface (`session-layout.tsx`) must mount
 * the deliverable-first action-panel system — `ActionPanel` (Easy is the one
 * panel default, a locked product decision), `BrowserPanel`, and the headless
 * `useDeliverableReadiness` — exactly as `origin/main` shipped it.
 *
 * This exists because the `origin/main` merge silently demoted that system:
 * the merged layout mounted only the branch's older `SessionActionsPanel`
 * (an ACP-tool-call stepper) as the panel body, so Easy mode never rendered
 * on the live page. `SessionActionsPanel` has since been removed — its ACP
 * tool-call content is covered by `ActionPanel`, which the layout now feeds
 * via `acpItemsToPanelMessages`. A source scan (the same style as
 * `acp-engine-exclusivity.test.ts`) is the cheapest guard that keeps this
 * from regressing again: a full mount of `SessionLayout` would drag in the
 * resizable-panel + sandbox-proxy + react-query world for no extra signal
 * about which panel it chose.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const LAYOUT_SOURCE = readFileSync(join(import.meta.dir, 'session-layout.tsx'), 'utf8');

describe('live session layout — deliverable-first ActionPanel default', () => {
  test('mounts ActionPanel from the action-panel system', () => {
    expect(LAYOUT_SOURCE).toMatch(
      /import\s*\{\s*ActionPanel\s*\}\s*from\s*'@\/features\/session\/action-panel'/,
    );
    // Actually rendered in the JSX body, not just imported.
    expect(LAYOUT_SOURCE).toMatch(/<ActionPanel\b/);
  });

  test('wires the deliverable-first supporting pieces (readiness + browser panel)', () => {
    expect(LAYOUT_SOURCE).toContain('useDeliverableReadiness');
    expect(LAYOUT_SOURCE).toMatch(
      /import\s*\{\s*BrowserPanel\s*\}\s*from\s*'@\/features\/session\/action-panel\/browser-panel'/,
    );
    expect(LAYOUT_SOURCE).toMatch(/<BrowserPanel\b/);
  });

  test('does not fall back to the removed SessionActionsPanel', () => {
    expect(LAYOUT_SOURCE).not.toContain('SessionActionsPanel');
    expect(LAYOUT_SOURCE).not.toContain('session-actions-panel');
  });

  test('feeds the ACP transcript into the panel via acpItemsToPanelMessages', () => {
    expect(LAYOUT_SOURCE).toContain('acpItemsToPanelMessages');
    // The panel is driven by the projected messages, not left undefined.
    expect(LAYOUT_SOURCE).toMatch(/<ActionPanel[\s\S]*?messages=\{messages\}/);
  });
});
