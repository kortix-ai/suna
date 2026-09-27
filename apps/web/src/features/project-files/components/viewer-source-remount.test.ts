import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { workspaceFileSource } from '@/features/files/file-source';

/**
 * The session Files explorer provides `sandboxExplorerSource`, whose
 * `useFileViewerSource()` swaps between two `FileSource` implementations:
 * the live workspace source while the sandbox is up, and the parked mirror
 * source while it is asleep. The two have different hook sequences — the
 * workspace `useFileContent` reads `useRuntimeStore` + `useServerHealth` +
 * `useQuery`, the mirror one reads `useProjectContext` + `useQuery`.
 *
 * The shared viewer calls `source.useFileContent` at a fixed hook position, so
 * a swap reused the previous implementation's hook state and React threw
 * `TypeError: Cannot read properties of undefined (reading 'length')` inside
 * `areHookInputsEqual` when it compared the new `useCallback` deps against the
 * other hook's memoized state. The fix keys the rendered viewer on the
 * source's stable `id`, which remounts it instead of reusing that state.
 *
 * Rendering the swap in this harness is not possible: `apps/web` has no DOM
 * (see `drive-toolbar.test.tsx`), so the update render that crashes cannot be
 * produced. The invariant is pinned against the source, in the same style as
 * `markdown-preview-toggle.test.ts`.
 */

const contentRenderer = readFileSync(
  fileURLToPath(new URL('./file-content-renderer.tsx', import.meta.url)),
  'utf8',
);
const previewModal = readFileSync(
  fileURLToPath(new URL('./file-preview-modal.tsx', import.meta.url)),
  'utf8',
);
const projectFileSource = readFileSync(
  fileURLToPath(new URL('../file-source.tsx', import.meta.url)),
  'utf8',
);

describe('viewer source identity', () => {
  test('the live and parked sources declare distinct ids', () => {
    expect(workspaceFileSource.id).toBe('sandbox-workspace');
    const parked = /id:\s*'([^']+)'/.exec(projectFileSource)?.[1];
    expect(parked).toBe('project-ref');
    expect(parked).not.toBe(workspaceFileSource.id);
  });

  test('the renderer remounts when the source implementation swaps', () => {
    expect(/<BaseFileContentRenderer key=\{source\.id\}/.test(contentRenderer)).toBe(true);
  });

  test('the preview modal remounts when the source implementation swaps', () => {
    expect(/<BaseFilePreviewModal\s+key=\{source\.id\}/.test(previewModal)).toBe(true);
  });

  test('the base viewer reads the source id it is keyed on', () => {
    // If the wrappers stop reading `source.id`, the keys above silently key on
    // `undefined` and the swap can reuse hook state again.
    expect(contentRenderer).toContain('useFileExplorerSource');
    expect(previewModal).toContain('useFileExplorerSource');
  });
});
