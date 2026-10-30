import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { ChangeList, DiffLayoutToggle } from './change-list';
import type { ChangeEntry, DiffLayout } from './change-vocabulary';

/**
 * The layout toggle's state handling, at the two seams a static render can
 * reach (this package has no browser harness — see the disclosure test):
 *
 * 1. the toggle reports the active layout through `aria-pressed`, so a click
 *    that fails to flip the state is visible in markup;
 * 2. the chosen layout flows into every row's diff viewport class, so a row
 *    that ignores the layout is visible in markup.
 *
 * The Pierre rendering itself (unified vs side-by-side columns) is proven
 * against the real component in a browser; see the PR's verification notes.
 */
const ENTRIES: ChangeEntry[] = [
  {
    path: 'src/new-file.ts',
    kind: 'added',
    additions: 3,
    deletions: 0,
    patch: [
      'diff --git a/src/new-file.ts b/src/new-file.ts',
      'new file mode 100644',
      'index 0000000..e69de29',
      '--- /dev/null',
      '+++ b/src/new-file.ts',
      '@@ -0,0 +1,3 @@',
      '+const a = 1;',
      '+const b = 2;',
      '+const c = 3;',
    ].join('\n'),
  },
];

test('the toggle reports exactly one active layout via aria-pressed', () => {
  const render = (layout: DiffLayout) => renderToStaticMarkup(<DiffLayoutToggle layout={layout} onChange={() => {}} />);

  const unified = render('unified');
  expect(unified).toContain('aria-label="Stacked"');
  expect(unified).toContain('aria-label="Side by side"');
  expect(unified).toMatch(/aria-label="Stacked"[^>]*aria-pressed="true"/);
  expect(unified).toMatch(/aria-label="Side by side"[^>]*aria-pressed="false"/);

  const split = render('split');
  expect(split).toMatch(/aria-label="Stacked"[^>]*aria-pressed="false"/);
  expect(split).toMatch(/aria-label="Side by side"[^>]*aria-pressed="true"/);
});

test('the layout flows into every row: side by side needs the wide viewport, stacked the narrow one', () => {
  const render = (layout: DiffLayout) =>
    renderToStaticMarkup(
      <ChangeList
        entries={ENTRIES}
        layout={layout}
        expanded={new Set(ENTRIES.map((e) => e.path))}
        onRowOpenChange={() => {}}
      />,
    );

  expect(render('split')).toContain('min-w-[860px]');
  expect(render('split')).not.toContain('min-w-[680px]');
  expect(render('unified')).toContain('min-w-[680px]');
  expect(render('unified')).not.toContain('min-w-[860px]');
});

test('a row without a patch renders the placeholder, not a diff viewport', () => {
  const html = renderToStaticMarkup(
    <ChangeList
      entries={[{ ...ENTRIES[0], patch: undefined }]}
      layout="split"
      expanded={new Set(ENTRIES.map((e) => e.path))}
      onRowOpenChange={() => {}}
    />,
  );
  expect(html).not.toContain('min-w-[860px]');
});
