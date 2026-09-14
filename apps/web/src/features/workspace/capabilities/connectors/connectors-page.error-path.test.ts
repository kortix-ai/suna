import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dir, 'connectors-page.tsx'), 'utf8');

/**
 * A source-assertion tripwire, in the shape of
 * `connector-tools.write-path.test.ts`.
 *
 * The page runs TWO queries and every flag read off the second one FAILS
 * CLOSED. `getProjectDetail` returning 500 leaves `experimental` undefined, so
 * `discoverEnabled` and `emailChannelEnabled` are both false, and two things
 * change with no error and no way back:
 *
 *   - the catalogue silently falls back from Discover to Easy Connect
 *     (`useCatalog`)
 *   - the custom-connector form loses its email-channel branch
 *     (`emailChannelEnabled`)
 *
 * react-query drops `isLoading` once a query has exhausted its retries, so the
 * page rendered as fully loaded and healthy while degraded. This is the third
 * time on this branch that a capability went silently absent behind a
 * condition nothing asserted, so the coupling is pinned rather than trusted.
 *
 * The fallback is now a deliberate feature rather than a failure mode — see
 * `use-catalog.ts` — but it must still be *reached* through a flag that came
 * from a query whose failure the page reports.
 */
describe('connectors page error path', () => {
  test('the grid reports a failure in EITHER query', () => {
    expect(source).toContain('const isError = connectorsQuery.isError || projectQuery.isError;');
    expect(source).toContain('isError={isError}');
    // A bare `connectorsQuery.isError` reaching the grid is the regression.
    expect(source).not.toContain('isError={connectorsQuery.isError}');
  });

  test('Retry refetches whichever query failed, not a fixed one', () => {
    const start = source.indexOf('const retry = useCallback(');
    const end = source.indexOf('const settled');
    // Both anchors must exist, or the slice silently widens to the whole file
    // and the two assertions below stop proving anything about `retry`.
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const retry = source.slice(start, end);
    expect(retry).toContain('connectorsQuery.refetch()');
    expect(retry).toContain('projectQuery.refetch()');
    expect(source).toContain('onRetry={retry}');
  });

  test('every flag the project query feeds is still derived from it alone', () => {
    // If a flag ever stops coming from `projectQuery`, the coupling above is
    // no longer sufficient and this test should be revisited rather than
    // silently outlived.
    // The flags now come from the ONE gating primitive, which reads the SAME
    // `qk.project.detail(projectId)` entry `projectQuery` holds — so the
    // coupling this file guards is unchanged, only the expression is.
    expect(source).toContain(
      "const discoverEnabled = useFeatureFlag(projectId, 'connectors_api_discover').enabled;",
    );
    expect(source).toContain(
      "const emailChannelEnabled = useFeatureFlag(projectId, 'agentmail_email').enabled;",
    );
    expect(source).toContain('queryKey: qk.project.detail(projectId)');
    // No hand-rolled flag read survives here.
    expect(source).not.toContain('?.experimental?.');
  });

  test('both add journeys end in the same handler shape', () => {
    // A flow omits the slug when the manifest write succeeded but the sync did
    // not. `DiscoverAddFlow` used to pass it anyway, so one partial failure
    // opened the detail modal from the catalogue and not from the custom form.
    // Both handlers now guard: `onCatalogAdded` and the custom form's own.
    // Matched without the brace: `onCatalogAdded`'s guard is a single
    // statement (`if (slug) showConnected(slug);`), the custom form's is a
    // block. What must hold is that BOTH guard, not how each is punctuated.
    expect(source.match(/if \(slug\)/g)).toHaveLength(2);
  });

  test('a newly created connector waits for a fresh list before missing-detail cleanup', () => {
    expect(source).toContain('const [pendingDetail, setPendingDetail] = useState<');
    expect(source).toContain(
      'setPendingDetail({ slug, dataUpdatedAt: connectorsQuery.dataUpdatedAt });',
    );
    expect(source).toContain('connectorsQuery.dataUpdatedAt > pendingDetail.dataUpdatedAt');
    expect(source).toContain('pendingDetail.slug !== detailSlug');
  });

  test('the plus button opens the custom form only', () => {
    // The whole point of the redesign. If `AddAppPanel` ever comes back to
    // this page, the catalogue is behind a modal again and the four tabs are
    // showing the user two different front doors to the same apps.
    //
    // Scoped to the import block and the JSX element rather than the whole
    // file: the page's own comments name `AddAppPanel` to explain what
    // replaced it, and a bare `toContain` cannot tell prose from code.
    const imports = source.slice(0, source.indexOf('const SCOPES'));
    expect(imports).not.toContain('AddAppPanel');
    expect(source).not.toContain('<AddAppPanel');
    expect(source).toContain("setPanel('custom')");
    expect(source).toContain('<CustomConnectorForm');
  });

  test('a catalogue card can only open the flow that made it', () => {
    // `CatalogEntry` is a discriminated union precisely so a Discover entry
    // cannot be handed to Pipedream's connection modal. Dropping either guard
    // would pass the wrong raw item to a flow that cannot build a draft
    // from it.
    expect(source).toContain("catalogTarget?.source === 'discover' ? catalogTarget.connector");
    expect(source).toContain("catalogTarget?.source === 'easy-connect' ? catalogTarget.app");
  });
});
