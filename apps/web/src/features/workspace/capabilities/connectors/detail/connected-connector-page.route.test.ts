import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const feature = import.meta.dir;
const appRoute = resolve(
  feature,
  '../../../../../app/(app)/projects/[id]/(capabilities)/connectors/[slug]/page.tsx',
);

describe('connected connector route', () => {
  test('renders connector management as a route instead of a modal', () => {
    const pagePath = join(feature, 'connected-connector-page.tsx');
    expect(existsSync(appRoute)).toBe(true);
    expect(existsSync(pagePath)).toBe(true);

    const route = readFileSync(appRoute, 'utf8');
    const page = readFileSync(pagePath, 'utf8');

    expect(route).toContain('<ConnectedConnectorPage');
    expect(page).toContain('qk.project.connectors(projectId)');
    expect(page).toContain('getConnectorConfig(projectId, connector.slug)');
    expect(page).toContain('<ConnectorDetailLayout');
    expect(page).toContain('type="underline"');
    expect(page).toContain('Accounts');
    expect(page).toContain('Tools');
    expect(page).toContain('Settings');
    expect(page).not.toContain('ModalContent');
  });

  test('a missing record during a fetch shows the skeleton, never "not found"', () => {
    const page = readFileSync(join(feature, 'connected-connector-page.tsx'), 'utf8');
    // The add flows invalidate the connectors list and navigate here in the
    // same tick — the warm cache predates the new slug. Only a SETTLED list
    // may declare the connector missing.
    expect(page).toContain('if (connectorsQuery.isFetching)');
  });

  test('Connect opens the split column, not an overlay', () => {
    const page = readFileSync(join(feature, 'connected-connector-page.tsx'), 'utf8');
    // The credential dialog renders as an inline SplitSheet column beside the
    // page (`shell="split"`); the page must never float it as a modal.
    expect(page).toContain('<SplitSheet open={credOpen}');
    expect(page).toContain('<SplitSheetMain');
    expect(page).toContain('shell="split"');
  });

  test('an add flow hands off into the connect dialog via ?connect=1', () => {
    const page = readFileSync(join(feature, 'connected-connector-page.tsx'), 'utf8');
    // The param is consumed once, stripped from the URL, and only opens the
    // dialog for connectors whose credential is entered on this page.
    expect(page).toContain("search?.get('connect') === '1'");
    expect(page).toContain('autoConnectRequested');
    expect(page).toContain("params.delete('connect')");
  });

  test('names the credential source and links the curated documentation', () => {
    const page = readFileSync(join(feature, 'connected-connector-page.tsx'), 'utf8');
    // The two-way Secrets link: a connector whose credential is a bound
    // project secret must say so on its page, not render the same state as a
    // pasted value.
    expect(page).toContain('<ConnectorCredentialRow');
    // Docs come from the curated per-app map, not a single generic link.
    expect(page).toContain('connectorDocLinks(connector)');
  });
});
