import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const page = readFileSync(join(import.meta.dir, 'connectors-page.tsx'), 'utf8');
const catalog = readFileSync(join(import.meta.dir, 'catalog', 'use-catalog.ts'), 'utf8');

/**
 * A source-assertion tripwire, in the shape of
 * `connectors-page.error-path.test.ts`.
 *
 * **The bug.** `listPipedreamApps` and `listPipedreamSections` are wired into
 * the API router only when `pipedreamConfigured()` is true — three env vars,
 * checked in `apps/api/src/connectors/pipedream.ts`. A self-host that never set
 * them gets `501 FEATURE_NOT_SUPPORTED` from both. This page fired them anyway
 * on every load, and `catalogErrorCopy()` has no 501 branch, so the Discovery
 * tab answered with the generic "Server error … The server failed to answer
 * (501). Retrying may work" card — over a catalogue that could never load, with
 * a Retry button that could never succeed.
 *
 * **The fix is a deployment probe, not error copy.** `GET
 * /connectors/connect-status` already existed for exactly this, and its own doc
 * comment says so. Softening the 501 copy would have kept two tabs that cannot
 * work; the tabs are removed instead, and the request is never sent.
 *
 * Three couplings hold that up, and none of them is visible from either file
 * alone — which is why they are pinned here rather than trusted:
 *
 *   1. the Easy Connect queries wait on the probe,
 *   2. the tab strip disappears only when the probe has CONFIRMED `absent`,
 *   3. `scope` is forced past whatever the `?scope=` URL param still asks for.
 *
 * Drop any one and the 501 card comes back — silently, and only on the
 * deployments that cannot report it.
 */
describe('connectors page without a Connect provider', () => {
  test('the Easy Connect queries are gated on the deployment probe', () => {
    // Both Pipedream-backed queries run off ONE derived flag, so neither can be
    // gated while the other is forgotten. `source === 'easy-connect'` reaching
    // an `enabled:` line again is the regression: it is true on exactly the
    // deployments that answer 501.
    expect(catalog).toContain('const connectStatus = useConnectProviderStatus(');
    expect(catalog).toContain('const easyConnectRunnable =');
    expect(catalog).toContain('enabled: opts.enabled && easyConnectRunnable,');
    expect(catalog).toContain("easyConnectProvider === 'pipedream'");
    expect(catalog).not.toContain("enabled: opts.enabled && source === 'easy-connect'");
  });

  test('a failed probe attempts Composio and never silently falls back to Pipedream', () => {
    // `unknown` is not `absent`. The safe automatic provider is Composio. A
    // failed status probe must surface the Composio catalogue error rather than
    // quietly spending against the legacy Pipedream account.
    expect(catalog).toContain(
      "(connectStatus.state === 'configured' || connectStatus.state === 'unknown')",
    );
    expect(catalog).toContain("return { state: 'unknown', provider: 'composio' };");
    expect(catalog).not.toContain("provider: 'auto'");
    expect(catalog).not.toContain('connectCatalogEndpointUnavailable');
    expect(catalog).toContain('retry: false,');
  });

  test('an open tab revalidates provider selection after a Composio deployment', () => {
    expect(catalog).toContain("queryKey: ['connect-status', 'composio-first-v2']");
    expect(catalog).toContain("refetchOnMount: 'always'");
    expect(catalog).not.toContain('staleTime: Infinity');
  });

  test('Composio wins whenever both managed providers are configured', () => {
    expect(catalog).toContain("const provider = providers.includes('composio')");
    expect(catalog).toContain(": providers.includes('pipedream')");
  });

  test('the wait for the probe reads as loading, not as an empty catalogue', () => {
    // A disabled react-query reports neither loading nor data. Without this the
    // grid would paint "no results" for a round trip, before the request it is
    // waiting on had even started.
    expect(catalog).toContain("connectStatus.state === 'asking' ||");
  });

  test('the probe outlives the tabs it closes', () => {
    // The probe must NOT be gated on `opts.enabled`. The page turns Discovery
    // and All off when it answers `absent`, which turns `enabled` off with
    // them; a probe that then stopped answering would reopen the tabs, which
    // would re-enable the probe — a strip that flickers forever.
    expect(catalog).toContain("useConnectProviderStatus(source === 'easy-connect')");
    expect(catalog).not.toContain('useConnectProviderStatus(opts.enabled');
  });

  test('the tab strip goes only when the catalogue is CONFIRMED absent', () => {
    // `discoverEnabled ||` is load-bearing twice over. `connectors_api_discover`
    // is a different catalogue backend entirely, so a project with that flag on
    // keeps Discovery and All whatever Pipedream's status is — and with the flag
    // off, Pipedream is the only catalogue left, so its absence removes both.
    expect(page).toContain('const connectStatus = useConnectProviderStatus(!discoverEnabled);');
    expect(page).toContain(
      "const catalogueAvailable = discoverEnabled || connectStatus.state !== 'absent';",
    );
    // `!== 'absent'`, never `=== 'configured'`: `asking` must render the page
    // exactly as it always has. Almost every deployment does have Pipedream,
    // and dropping two tabs for a beat on every load to spare a minority one
    // failed request is the wrong trade.
    expect(page).not.toContain("connectStatus.state === 'configured'");
  });

  test('the strip is removed, not disabled, and leaves no empty row behind', () => {
    // `CapabilityPageShell` drops the whole filter row when `filters` is
    // undefined and keeps it for anything truthy — so a fragment here would
    // leave a 28px gap where the tabs used to be. `visibleScopes` is what
    // decides this now, not `catalogueAvailable` directly: Channels means a
    // catalogue-less deployment still has two real destinations (Connected,
    // Channels), so the strip only fully disappears when fewer than two
    // scopes remain — a single remaining tab is not a choice either.
    expect(page).toContain('filters={');
    expect(page).toContain('visibleScopes.length > 1 ? (');
    expect(page).toContain(') : undefined');
    expect(page).toContain(
      "const visibleScopes = catalogueAvailable\n    ? SCOPES\n    : SCOPES.filter((s) => s !== 'discover' && s !== 'all');",
    );
    expect(page).not.toContain('disabled={!catalogueAvailable}');
  });

  test('scope is forced to Connected, not defaulted to it', () => {
    // The `?scope=` param outlives the answer it was read under: the user can
    // click Discovery in the beat before the probe lands, and an OAuth return
    // brings them back to this page with that param still in the URL. Reading
    // it blindly would strand them on a tab the strip no longer renders — the
    // catalogue would mount, fire, and 501 with nothing to switch away to.
    // Connected and Channels never need the catalogue, so they are exempt
    // from the force.
    expect(page).toContain(
      "const requestedScope: ConnectorScope = parseScope(search?.get('scope') ?? null) ?? 'discover';",
    );
    expect(page).toContain(
      "catalogueAvailable || requestedScope === 'connected' || requestedScope === 'channels'",
    );
    expect(page).not.toContain("const scope: ConnectorScope = scopeChoice ?? 'discover';");
    // `catalogActive` is what mounts `ConnectorBrowse`, and it is derived from
    // the forced `scope` — so the forcing above is also what keeps the
    // catalogue unmounted. It names the two catalogue scopes explicitly now
    // rather than `!== 'connected'`, since Channels is also not-connected but
    // must not mount the catalogue either.
    expect(page).toContain("const catalogActive = scope === 'discover' || scope === 'all';");
  });

  test('the Connected empty state offers no tab that is not there', () => {
    // "Browse the catalogue" sets `scope` to `discover`. With no catalogue
    // that is a button to a hidden tab, and the forced `scope` would swallow
    // the click — a control that visibly does nothing.
    const start = page.indexOf('title="No connectors yet"');
    const end = page.indexOf('</CatalogGrid>');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const emptyState = page.slice(start, end);
    expect(emptyState).toContain('catalogueAvailable ? (');
    expect(emptyState).toContain('Browse the catalogue');
  });
});
