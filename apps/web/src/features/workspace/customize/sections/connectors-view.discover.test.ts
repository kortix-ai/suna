import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = [
  readFileSync(join(import.meta.dir, 'connectors-view.tsx'), 'utf8'),
  readFileSync(join(import.meta.dir, 'discover-catalogue.tsx'), 'utf8'),
].join('\n');

describe('Discover connector marketplace', () => {
  test('replaces Easy Connect with an always-available Discover tab', () => {
    expect(source).toContain('<TabsTrigger value="discover">Discover</TabsTrigger>');
    expect(source).toContain('<DiscoverCatalogue projectId={projectId} onAdded={onAdded} />');
    expect(source).not.toContain('value="apps">{easyConnectLabel}');
  });

  test('renders direct catalogue records before optional Pipedream OAuth alternatives', () => {
    expect(source).toContain('const discoverCards = [...integrationCards, ...pipedreamOAuthCards]');
    expect(source).toContain('Pipedream OAuth');
    expect(source).toContain("app.authType === 'oauth'");
    expect(source.indexOf('...integrationCards')).toBeLessThan(
      source.indexOf('...pipedreamOAuthCards'),
    );
  });

  test('opens direct records as domain variants instead of routing them through Pipedream', () => {
    expect(source).toContain('getDiscoverIntegration(projectId, selectedIntegration.id)');
    expect(source).toContain('variant.connector');
    expect(source).toContain('Configure manually');
  });
});
