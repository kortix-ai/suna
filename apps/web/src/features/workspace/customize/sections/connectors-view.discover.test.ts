import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const connectorsSource = readFileSync(join(import.meta.dir, 'connectors-view.tsx'), 'utf8');
const discoverPath = join(import.meta.dir, 'discover-catalogue.tsx');
const discoverSource = existsSync(discoverPath) ? readFileSync(discoverPath, 'utf8') : '';

describe('feature-flagged Discover connector marketplace', () => {
  test('keeps Easy Connect and adds Discover only for explicit project opt-in', () => {
    expect(connectorsSource).toContain(
      'projectQuery.data?.project?.experimental?.connectors_api_discover === true',
    );
    expect(connectorsSource).toContain('<TabsTrigger value="apps">{easyConnectLabel}</TabsTrigger>',
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
    expect(connectorsSource).toContain('<AppCatalogue projectId={projectId} onAdded={onAdded} />');
  });

  test('renders direct records before separately labelled Pipedream OAuth entries', () => {
    expect(discoverSource).toContain(
      'const discoverCards = [...integrationCards, ...pipedreamOAuthCards]',
    );
    expect(discoverSource).toContain('Pipedream OAuth');
    expect(discoverSource).toContain("app.authType === 'oauth'");
    expect(discoverSource.indexOf('...integrationCards')).toBeLessThan(
      discoverSource.indexOf('...pipedreamOAuthCards'),
    );
  });

  test('opens direct records as source variants instead of routing through Pipedream', () => {
    expect(discoverSource).toContain(
      'getDiscoverIntegration(projectId, selectedIntegration.id)');
    expect(discoverSource).toContain('variant.connector');
    expect(discoverSource).toContain('Configure manually');
  });

  test('does not mislabel a domain card as only its feed-provided MCP surface', () => {
    expect(discoverSource).toContain("const subtitle = isOAuth ? 'Pipedream OAuth' : 'Direct surfaces';",
    );
    expect(discoverSource).not.toContain(
      "const subtitle = isOAuth ? 'Pipedream OAuth' : integrationKindLabel(card.item.kind);",
    );
  });
});
