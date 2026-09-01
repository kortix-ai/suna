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
    expect(page).toContain('<ConnectorAdvanced');
    expect(page).toContain('type="underline"');
    expect(page).toContain('Accounts');
    expect(page).toContain('Tools');
    expect(page).toContain('Settings');
    expect(page).not.toContain('ModalContent');
  });
});
