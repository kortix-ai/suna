import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The markdown source/preview toggle was dead on every markdown file, on both
 * surfaces that own it.
 *
 * `setIsMarkdownPreview` is memoized on the preview flag itself, so its
 * identity changes every time the flag flips. The "reset when the file
 * changes" effect listed that callback as a dependency AND called it, so a
 * toggle re-ran the effect and forced the flag back to `true` inside the same
 * commit. The button flipped and snapped back, which reads as a button that
 * does nothing — in `file-content-renderer`'s own header and in
 * `file-preview-modal`'s toolbar, which drives the same state through
 * `onMarkdownPreviewChange`.
 *
 * Rendering this component in a test is not practical (it pulls next-intl,
 * CodeMirror and a file source), so the invariant is pinned against the
 * source, in the same style as `project-icon-field.test.tsx`.
 */

const source = readFileSync(
  fileURLToPath(new URL('./file-content-renderer.tsx', import.meta.url)),
  'utf8',
);

/** The `useEffect(...)` block whose body resets per-file view state. */
function resetEffect(): string {
  const start = source.indexOf('setInternalMarkdownPreview(true);');
  expect(start).toBeGreaterThan(-1);
  const open = source.lastIndexOf('useEffect(() => {', start);
  expect(open).toBeGreaterThan(-1);
  // The block ends at its dependency array, not at a `});` — the body has no
  // nested call to close, so searching for `});` runs into the NEXT effect.
  const close = source.indexOf('}, [', start);
  expect(close).toBeGreaterThan(-1);
  const end = source.indexOf(');', close);
  return source.slice(open, end + 2);
}

describe('per-file reset effect', () => {
  test('depends on the file path and nothing else', () => {
    const deps = /\}, \[([^\]]*)\]\);?\s*$/.exec(resetEffect().trim())?.[1] ?? '';
    const listed = deps
      .split(',')
      .map((d) => d.trim())
      .filter(Boolean);

    expect(listed).toEqual(['filePath']);
  });

  test('does not call the memoized setter, whose identity tracks the flag', () => {
    // The whole failure: this callback is recreated on every flip, so calling
    // it here — or listing it above — makes the reset chase the toggle.
    expect(resetEffect()).not.toContain('setIsMarkdownPreview');
  });

  test('the setter really is memoized on the flag it would reset', () => {
    // If this stops being true the guards above are merely harmless, not
    // load-bearing — and this test should be revisited rather than deleted.
    const memo = /const setIsMarkdownPreview = useCallback\([\s\S]*?\n {4}\[([^\]]*)\],/.exec(
      source,
    );
    expect(memo).not.toBeNull();
    expect(memo?.[1]).toContain('isMarkdownPreview');
  });
});
