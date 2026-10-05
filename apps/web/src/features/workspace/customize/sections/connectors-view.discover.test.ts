import { existsSync, readFileSync } from '@/i18n/test-source';
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

const connectorsSource = readFileSync(join(import.meta.dir, 'connectors-view.tsx'), 'utf8');
const discoverPath = join(import.meta.dir, 'discover-catalogue.tsx');
const discoverSource = existsSync(discoverPath) ? readFileSync(discoverPath, 'utf8') : '';

describe('feature-flagged Discover connector marketplace', () => {
  // `AddAppPanel` takes `discoverEnabled` as a prop; it no longer computes the
  // flag itself. The legacy `ConnectorsMasterDetail` wrapper that used to wire
  // `useFeatureFlag(projectId, 'connectors_api_discover')` here was dead code
  // (0 importers, unreachable from the live route) and was deleted. The live
  // route computes the flag in
  // `features/workspace/capabilities/connectors/connectors-page.tsx` instead.
  test('keeps Easy Connect and adds Discover only for explicit project opt-in', () => {
    expect(connectorsSource).toContain(
      '<TabsTrigger value="apps">{easyConnectLabel}</TabsTrigger>',
    );
    expect(connectorsSource).toContain("raw('i18nComplete.textd4a33d5b78bc')");
    expect(connectorsSource).toContain(
      '{discoverEnabled && (\n          <TabsContent value="discover"',
    );
  });

  test('does not replace the existing Easy Connect default', () => {
    expect(connectorsSource).toContain(
      "const defaultTab = !easyConnectDisabled ? 'apps' : discoverEnabled ? 'discover' : 'channels';",
    );
    expect(connectorsSource).toContain('<AppCatalogue');
    expect(connectorsSource).toContain('existingSlugs={existingSlugs}');
  });

  test('renders direct records before separately labelled Pipedream OAuth entries', () => {
    expect(discoverSource).toContain(
      'const discoverCards = [...connectorCards, ...pipedreamOAuthCards]',
    );
    expect(discoverSource).toContain('Pipedream OAuth');
    expect(discoverSource).toContain("app.authType === 'oauth'");
    expect(discoverSource.indexOf('...connectorCards')).toBeLessThan(
      discoverSource.indexOf('...pipedreamOAuthCards'),
    );
  });

  test('opens direct records as source variants instead of routing through Pipedream', () => {
    expect(discoverSource).toContain('getDiscoverConnector(projectId, selectedConnector.id)');
    expect(discoverSource).toContain('variant.connector');
    expect(discoverSource).toContain('Configure manually');
  });

  test('collects an explicit connection before creating either connector type', () => {
    expect(discoverSource).toContain('<ConnectorConnectionModal');
    expect(discoverSource).toContain('existingSlugs={existingSlugs}');
    expect(discoverSource).toContain(
      'proposeConnectorConnectionSlug(connectionDisplayName, existingSlugs)',
    );
    expect(discoverSource).toContain('createOnlyConnectorDraft(draft)');
    // No `authorization_strategy` on the draft — ownership is an ACCOUNT
    // property (`owner_type`), not a connector-level mode chosen at creation.
    expect(discoverSource).not.toContain('authorization_strategy');
  });

  test('does not mislabel a domain card as only its feed-provided MCP surface', () => {
    expect(discoverSource).toContain('const subtitle = isOAuth');
    expect(discoverSource).toContain("? tI18nComplete.raw('text87a46ec2620a')");
    expect(discoverSource).toContain(": tI18nComplete.raw('text678094dc2f3f')");
    expect(discoverSource).not.toContain(
      "const subtitle = isOAuth ? 'Pipedream OAuth' : connectorKindLabel(card.item.kind);",
    );
  });
});
