import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The project default-effort row, pinned the way `general-tab.rename.test.tsx`
 * pins the rename: as a scan of the source the component actually renders.
 * The same constraints apply — `apps/web`'s `bun test` runs WITHOUT
 * `--isolate`, so mocking `@tanstack/react-query` or `@kortix/sdk` here would
 * corrupt every other file in the run, and there is no jsdom harness — so
 * these tests hold the wiring the renderer cannot observe:
 *
 * - the mutation goes through the SDK's `setDefaultReasoningEffort`, which is
 *   the one client for `PUT /v1/projects/:id/default-reasoning-effort`;
 * - the picker's Automatic entry (the shared `''` sentinel) is sent as
 *   `null` — the API's clear verb — and every real effort is sent verbatim;
 * - a save writes the result into `qk.project.summary(...)` so the row and
 *   every other summary reader repaint without a refetch;
 * - the Select's value falls back to the Automatic sentinel when the project
 *   carries no stored default (the serialized field is `null`, and Radix
 *   rejects an unlisted value), and Automatic is the FIRST option so the
 *   control never opens on an effort the project does not actually have.
 */
const source = readFileSync(join(import.meta.dir, 'general-tab.tsx'), 'utf8');
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const cardStart = code.indexOf('function GeneralWorkspaceCard(');
const cardEnd = code.indexOf('export function GeneralTab(', cardStart);
const cardBody = cardStart < 0 || cardEnd < 0 ? '' : code.slice(cardStart, cardEnd);

// Scope to the effort mutation itself: the card now declares three
// `useMutation` blocks (rename, icon, effort), so anchor on the SDK call the
// effort mutation is the only one to contain.
const effortAnchor = cardBody.indexOf('setDefaultReasoningEffort(project.project_id, effort)');
const effortStart = effortAnchor < 0 ? -1 : cardBody.lastIndexOf('useMutation({', effortAnchor);
const effortEnd = effortAnchor < 0 ? -1 : cardBody.indexOf('});', effortAnchor);
const effortBlock =
  effortStart < 0 || effortEnd < 0 ? '' : cardBody.slice(effortStart, effortEnd);

describe('GeneralWorkspaceCard: the default-effort row', () => {
  test('the scan found the effort mutation', () => {
    expect(cardBody.length).toBeGreaterThan(0);
    expect(effortBlock.length).toBeGreaterThan(0);
  });

  test('the write goes through the SDK client for the dedicated route', () => {
    expect(effortBlock).toContain('setDefaultReasoningEffort(project.project_id, effort)');
  });

  test('the Automatic sentinel is sent as null — the API clear verb', () => {
    // The handler lives in the row's JSX, outside the mutation block.
    expect(cardBody).toMatch(
      /effortMutation\.mutate\(v === DEFAULT_EFFORT_AUTOMATIC \? null : v\)/,
    );
  });

  test('a save repaints the project summary cache, not a refetch', () => {
    expect(effortBlock).toContain('queryClient.setQueryData(qk.project.summary(project.project_id), updated)');
  });

  test('the Select falls back to the Automatic sentinel when no default is stored', () => {
    expect(cardBody).toContain('value={project.default_reasoning_effort ?? DEFAULT_EFFORT_AUTOMATIC}');
  });

  test('Automatic is offered first, before every effort value', () => {
    const selectStart = cardBody.indexOf('<Select');
    const selectEnd = cardBody.indexOf('</Select>', selectStart);
    const selectBlock = selectStart < 0 ? '' : cardBody.slice(selectStart, selectEnd);
    expect(selectBlock.indexOf('DEFAULT_EFFORT_AUTOMATIC')).toBeLessThan(
      selectBlock.indexOf('DEFAULT_EFFORT_OPTIONS.map'),
    );
  });
});
