import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `SettingsView`'s `GeneralWorkspaceCard` cannot be rendered or driven here:
 * `apps/web`'s `bun test` runs WITHOUT `--isolate`, so mocking
 * `@tanstack/react-query` process-wide would corrupt every other file in the
 * run, and there is no jsdom/`@testing-library/react` harness here either.
 *
 * So the coverage is split in two, and neither half alone proves the fix:
 * this file pins that `GeneralWorkspaceCard`'s rename `mutation` wires
 * `onMutate`/`onError`/`onSettled` to the shared `renameOnMutate`/
 * `renameOnError`/`renameOnSettled` functions — the gap a
 * helpers-in-isolation test cannot see, because a silent revert to a local
 * no-op still passes it — while `workspace-rename-cache.test.ts` proves what
 * those functions DO, including the Critical rollback path, against a real
 * QueryClient.
 *
 * This card is now the ONLY rename path. The old edit modal was the other
 * one and had its own paired source-scan file; the workspace-switcher work
 * deleted that modal, so both went with it.
 */
const source = readFileSync(join(import.meta.dir, 'settings-view.tsx'), 'utf8');
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

// settings-view.tsx declares several `useMutation({…})` calls (archive, repo
// settings, experimental features, sandbox provider, the rename here) — scope
// the scan to GeneralWorkspaceCard's own body so a match can only come from
// ITS mutation, not a sibling's.
const cardStart = code.indexOf('function GeneralWorkspaceCard(');
const cardEnd = code.indexOf('function SaveStatus(', cardStart);
const cardBody = cardStart < 0 || cardEnd < 0 ? '' : code.slice(cardStart, cardEnd);

const mutationStart = cardBody.indexOf('useMutation({');
const mutationEnd = cardBody.indexOf('});', mutationStart);
const mutationBlock =
  mutationStart < 0 || mutationEnd < 0 ? '' : cardBody.slice(mutationStart, mutationEnd);

describe('GeneralWorkspaceCard: the source the component actually renders', () => {
  test('the scan found the rename mutation', () => {
    // Guard the guards: an empty string passes `.not.toContain` silently.
    expect(cardBody.length).toBeGreaterThan(0);
    expect(mutationBlock.length).toBeGreaterThan(0);
    expect(mutationBlock).toContain('mutationFn:');
    expect(mutationBlock).toContain('updateWorkspace(workspace.workspace_id');
  });

  test('onMutate is wired to the shared renameOnMutate, not a local write', () => {
    // `patch.name`, not a bare name variable: this mutation carries the icon
    // edits migrated here from the deleted `EditProjectModal`, so its
    // variables are a `Partial<WorkspaceInput>`. `renameOnMutate` returns
    // `undefined` for a patch with no `name`, which is what makes an
    // icon-only save write nothing optimistic and roll nothing back.
    expect(mutationBlock).toMatch(
      /onMutate:\s*\(patch\)\s*=>\s*renameOnMutate\(queryClient,\s*workspace\.workspace_id,\s*patch\.name\)/,
    );
  });

  test('onError is wired to the shared renameOnError — the rollback call', () => {
    const onErrorStart = mutationBlock.indexOf('onError:');
    const onErrorBlock = mutationBlock.slice(onErrorStart, mutationBlock.indexOf('onSettled:'));
    expect(onErrorBlock).toContain('renameOnError(queryClient, workspace.workspace_id, context)');
  });

  test('onSettled is wired to the shared renameOnSettled', () => {
    expect(mutationBlock).toMatch(
      /onSettled:\s*\(\)\s*=>\s*renameOnSettled\(queryClient,\s*workspace\.workspace_id\)/,
    );
  });
});
