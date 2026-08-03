import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dir, 'connectors-page.tsx'), 'utf8');

/**
 * A source-assertion tripwire, in the shape of
 * `rung-permissions.write-path.test.ts`.
 *
 * The page runs TWO queries and every flag read off the second one FAILS
 * CLOSED. `getProjectDetail` returning 500 leaves `experimental` undefined, so
 * `browseEnabled` and `emailChannelEnabled` are both false, and three surfaces
 * disappear with no error and no way back:
 *
 *   - the **Browse** filter chip (`visibleScopes`)
 *   - `AddAppPanel`'s **Discover** tab (`discoverEnabled`)
 *   - `AddAppPanel`'s **Channels** tab (`emailChannelEnabled`)
 *
 * react-query drops `isLoading` once a query has exhausted its retries, so the
 * page rendered as fully loaded and healthy while missing all three. This is
 * the third time on this branch that a capability went silently absent behind
 * a condition nothing asserted, so the coupling is pinned rather than trusted.
 */
describe('connectors page error path', () => {
  test('the grid reports a failure in EITHER query', () => {
    expect(source).toContain(
      'const isError = connectorsQuery.isError || projectQuery.isError;',
    );
    expect(source).toContain('isError={isError}');
    // A bare `connectorsQuery.isError` reaching the grid is the regression.
    expect(source).not.toContain('isError={connectorsQuery.isError}');
  });

  test('Retry refetches whichever query failed, not a fixed one', () => {
    const retry = source.slice(
      source.indexOf('const retry = useCallback('),
      source.indexOf('const rawScope'),
    );
    expect(retry).toContain('connectorsQuery.refetch()');
    expect(retry).toContain('projectQuery.refetch()');
    expect(source).toContain('onRetry={retry}');
  });

  test('every flag the project query feeds is still derived from it alone', () => {
    // If a flag ever stops coming from `projectQuery`, the coupling above is
    // no longer sufficient and this test should be revisited rather than
    // silently outlived.
    expect(source).toContain('const experimental = projectQuery.data?.project?.experimental;');
    expect(source).toContain("browseEnabled = experimental?.connectors_api_discover === true");
    expect(source).toContain("emailChannelEnabled = experimental?.agentmail_email === true");
  });

  test('both add journeys end in the same handler shape', () => {
    // `AddAppPanel` omits the slug when the manifest write succeeded but the
    // sync did not (`connectors-view.tsx:3813`). `DiscoverAddFlow` used to
    // pass it, so one partial failure opened the detail modal from Browse and
    // not from Add connector. Both handlers now guard.
    expect(source.match(/if \(slug\) \{/g)).toHaveLength(2);
  });
});
