import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const connectorsSource = readFileSync(join(import.meta.dir, 'connectors-view.tsx'), 'utf8');
const discoverPath = join(import.meta.dir, 'discover-catalogue.tsx');
const discoverSource = existsSync(discoverPath) ? readFileSync(discoverPath, 'utf8') : '';

describe('feature-flagged Discover connector marketplace', () => {
  test('keeps Easy Connect and adds Discover only for explicit project opt-in', () => {
    expect(connectorsSource).toContain(
      "const discoverEnabled = useFeatureFlag(workspaceId, 'connectors_api_discover').enabled;",
    );
    expect(connectorsSource).toContain(
      '<TabsTrigger value="apps">{easyConnectLabel}</TabsTrigger>',
    );
    expect(connectorsSource).toContain(
      '{discoverEnabled && <TabsTrigger value="discover">Discover</TabsTrigger>}',
    );
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
    expect(discoverSource).toContain('getDiscoverConnector(workspaceId, selectedConnector.id)');
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
    expect(discoverSource).toContain('authorization_strategy: connection.authorizationStrategy');
  });

  test('does not mislabel a domain card as only its feed-provided MCP surface', () => {
    expect(discoverSource).toContain(
      "const subtitle = isOAuth ? 'Pipedream OAuth' : 'Direct surfaces';",
    );
    expect(discoverSource).not.toContain(
      "const subtitle = isOAuth ? 'Pipedream OAuth' : connectorKindLabel(card.item.kind);",
    );
  });
});
