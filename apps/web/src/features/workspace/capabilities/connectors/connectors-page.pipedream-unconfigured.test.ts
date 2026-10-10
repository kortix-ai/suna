import { describe, expect, test } from 'bun:test';
import { readFileSync } from '@/i18n/test-source';
import { join } from 'node:path';

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
    expect(catalog).toContain('useConnectProviderStatus(true)');
    expect(catalog).not.toContain('useConnectProviderStatus(opts.enabled');
  });

});
