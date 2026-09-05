import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * `detail-selection.test.ts` pins the RULE. This pins the WIRING, because the
 * rule being correct buys nothing if a page stops using it.
 *
 * The regression is a one-line edit that reads as an obvious simplification —
 *
 *   -  open={detail.open}
 *   +  open={selected !== null}
 *
 * — and it silently hands the modal back to the query. Nothing type-checks
 * differently, no test of the page's own logic fails, and the symptom
 * (a modal that opens by itself after an OAuth redirect, or vanishes when one
 * of four refetches errors) shows up as a timing-dependent bug report weeks
 * later. So the shape is asserted at its call sites.
 */

const PAGES = [
  { name: 'connectors', file: '../connectors/connectors-page.tsx', clear: 'setDetailSlug(null)' },
  { name: 'skills', file: '../skills/skills-page.tsx', clear: 'setSelectedPath(null)' },
] as const;

const read = (relativePath: string) =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');

const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

for (const page of PAGES) {
  describe(`${page.name} page — modal open follows intent`, () => {
    const code = stripComments(read(page.file));

    test('routes its selection through detailSelection', () => {
      expect(code).toContain('detailSelection({');
      expect(code).toContain('isSuccess:');
    });

    test('open is bound to the selection, never to a lookup result', () => {
      expect(code).toContain('open={detail.open}');
      // The exact expressions this replaced. Any of them means `open` is a
      // function of query data again.
      expect(code).not.toContain('open={selectedConnector !== null}');
      expect(code).not.toContain('open={selectedSkill !== null}');
      expect(code).not.toContain('open={selectedCommand !== null}');
      expect(code).not.toMatch(/open=\{[^}]*\.find\(/);
    });

    test('a selection whose record has not arrived renders the shell', () => {
      // Without this the modal is `open` with an empty body — a blank sheet
      // over the page, which is worse than the bug it replaced.
      expect(code).toContain('isResolving={detail.isResolving}');
    });

    test('it closes only on a CONFIRMED miss, and clears the selection to do it', () => {
      expect(code).toContain('detail.isMissing');
      const effect = code.slice(code.indexOf('detail.isMissing'));
      expect(effect).toContain(page.clear);
      // `isLoading` cannot stand in for `isSuccess`: react-query reports
      // `isLoading === false` once retries are exhausted, so a network failure
      // would read as a deletion.
      expect(code).not.toMatch(/isSuccess:\s*!\w+\.isLoading/);
    });
  });
}

describe('modal shells exist for the resolving window', () => {
  test('ConnectorModal accepts isResolving and renders a skeleton, not null', () => {
    const code = stripComments(read('../connectors/detail/connector-modal.tsx'));
    expect(code).toContain('isResolving');
    expect(code).toContain('<ConnectorModalSkeleton />');
    // Radix Dialog requires an accessible name for as long as it is open.
    expect(code).toContain('<ModalTitle>Loading connector</ModalTitle>');
  });

  test('EntityDetailModal accepts isResolving and renders a skeleton, not null', () => {
    const code = stripComments(read('./entity/entity-modal.tsx'));
    expect(code).toContain('isResolving');
    expect(code).toContain('<EntityModalSkeleton kind={kind} />');
    expect(code).toContain('Loading {kind}');
  });
});

describe('catalogue search keeps its results', () => {
  const code = stripComments(read('../connectors/catalog/use-catalog.ts'));

  test('both catalogue queries keep the previous page while a search is in flight', () => {
    // The query key carries `activeQuery`, so every debounced keystroke is a
    // NEW key. Without this the grid drops to six skeleton cards each time.
    expect(code.match(/placeholderData: keepPreviousData/g)).toHaveLength(2);
    expect(code).toContain('keepPreviousData');
  });

  test('the cold state and the refreshing state are reported separately', () => {
    expect(code).toContain('isRefreshing:');
    expect(code).toContain('isRefreshing: opts.enabled && isPlaceholderData');
  });

  test('no paging path runs against placeholder data', () => {
    // `loadedPages`/`hasNextPage` describe the PREVIOUS key while the
    // placeholder shows, so paging off them fires a cursor request for a query
    // whose first page has not landed.
    //
    // There is now exactly ONE way to reach `fetchNextPage` — `loadMore`,
    // called by the scroll sentinel and by the "Load more" button. The
    // automatic chain that also called it is gone, so this used to assert the
    // guard at two entry points and now asserts it at the only one.
    expect(code.match(/fetchNextPage\(\)/g)).toHaveLength(1);
    expect(code).toContain('if (!hasNextPage || isFetchingNextPage || isPlaceholderData) return;');
    // `hasMore` is what the sentinel and the button both read, so withholding
    // it during the placeholder window disarms both at once.
    expect(code).toContain('hasMore: opts.enabled && hasNextPage && !isPlaceholderData');
  });

  test('the browse grid dims instead of blanking', () => {
    const browse = stripComments(read('../connectors/catalog/connector-browse.tsx'));
    expect(browse).toContain('state.isRefreshing');
    expect(browse).toContain('aria-busy');
    // A dimmed card must not be clickable — the entry under the pointer is
    // about to be replaced by a different one in the same grid position.
    expect(browse).toContain('pointer-events-none');
  });
});

/**
 * Agents left this list on purpose (Marko, 2026-09-01: Customize is
 * agent-centric). An agent card no longer opens a modal — it is a link to the
 * agent's own routed page (`agentHref`), so there is no selection to keep
 * honest here. Pinned so a modal does not quietly come back: the page must
 * not import the entity modal, and every card must carry the href.
 */
describe('agents page — cards are links, not a modal', () => {
  const code = stripComments(read('../agents/agents-page.tsx'));

  test('does not mount the entity detail modal', () => {
    expect(code).not.toContain('EntityDetailModal');
    expect(code).not.toContain('detailSelection(');
  });

  test('every card navigates to the agent page', () => {
    expect(code).toContain('href={agentHref(projectId, agent.name)}');
    expect(code).not.toContain('router.push');
  });
});
