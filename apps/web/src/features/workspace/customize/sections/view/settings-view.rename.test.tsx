import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `SettingsView`'s `GeneralProjectCard` cannot be rendered or driven here —
 * same reasoning as `edit-project-modal.rename.test.tsx`'s doc comment:
 * `apps/web`'s `bun test` runs WITHOUT `--isolate`, so mocking
 * `@tanstack/react-query` process-wide would corrupt every other file in the
 * run, and there is no jsdom/`@testing-library/react` harness here either.
 *
 * Same split as that file: this pins that `GeneralProjectCard`'s rename
 * `mutation` wires `onMutate`/`onError`/`onSettled` to the shared
 * `renameOnMutate`/`renameOnError`/`renameOnSettled` functions — the second
 * rename path this task's fix round added rollback to — while
 * `project-rename-cache.test.ts` proves what those functions DO, including
 * the Critical rollback path, against a real QueryClient.
 */
const source = readFileSync(join(import.meta.dir, 'settings-view.tsx'), 'utf8');
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

// settings-view.tsx declares several `useMutation({…})` calls (archive, repo
// settings, experimental features, sandbox provider, the rename here) — scope
// the scan to GeneralProjectCard's own body so a match can only come from
// ITS mutation, not a sibling's.
const cardStart = code.indexOf('function GeneralProjectCard(');
const cardEnd = code.indexOf('function SaveStatus(', cardStart);
const cardBody = cardStart < 0 || cardEnd < 0 ? '' : code.slice(cardStart, cardEnd);

const mutationStart = cardBody.indexOf('useMutation({');
const mutationEnd = cardBody.indexOf('});', mutationStart);
const mutationBlock =
  mutationStart < 0 || mutationEnd < 0 ? '' : cardBody.slice(mutationStart, mutationEnd);

describe('GeneralProjectCard: the source the component actually renders', () => {
  test('the scan found the rename mutation', () => {
    // Guard the guards: an empty string passes `.not.toContain` silently.
    expect(cardBody.length).toBeGreaterThan(0);
    expect(mutationBlock.length).toBeGreaterThan(0);
    expect(mutationBlock).toContain('mutationFn:');
    expect(mutationBlock).toContain('updateProject(project.project_id');
  });

  test('onMutate is wired to the shared renameOnMutate, not a local write', () => {
    expect(mutationBlock).toMatch(
      /onMutate:\s*\(nextName\)\s*=>\s*renameOnMutate\(queryClient,\s*project\.project_id,\s*nextName\)/,
    );
  });

  test('onError is wired to the shared renameOnError — the rollback call', () => {
    const onErrorStart = mutationBlock.indexOf('onError:');
    const onErrorBlock = mutationBlock.slice(onErrorStart, mutationBlock.indexOf('onSettled:'));
    expect(onErrorBlock).toContain('renameOnError(queryClient, project.project_id, context)');
  });

  test('onSettled is wired to the shared renameOnSettled', () => {
    expect(mutationBlock).toMatch(
      /onSettled:\s*\(\)\s*=>\s*renameOnSettled\(queryClient,\s*project\.project_id\)/,
    );
  });
});
