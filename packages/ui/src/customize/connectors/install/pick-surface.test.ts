import type { DiscoverConnectorVariant } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';

import { installableVariants, pickSurface, surfaceInstallName } from './pick-surface';

const variant = (
  kind: DiscoverConnectorVariant['kind'],
  id: string,
  installable = true,
): DiscoverConnectorVariant => ({
  id,
  kind,
  name: `${id} surface`,
  url: null,
  docs: null,
  description: null,
  transports: [],
  requiresAuth: false,
  command: null,
  connector: installable ? { provider: kind === 'mcp' ? 'mcp' : 'openapi' } : null,
});

describe('installableVariants', () => {
  test('MCP leads, the rest keep catalogue order', () => {
    const order = installableVariants([
      variant('openapi', 'rest'),
      variant('graphql', 'gql'),
      variant('mcp', 'mcp'),
    ]).map((v) => v.id);
    expect(order[0]).toBe('mcp');
    expect(order[1]).toBe('rest');
    expect(order[2]).toBe('gql');
  });

  test('a variant with no template is left out', () => {
    expect(installableVariants([variant('cli', 'cli', false), variant('openapi', 'rest')])).toEqual(
      [{ id: 'rest', kind: 'openapi', name: 'rest surface', template: { provider: 'openapi' } }],
    );
  });
});

describe('pickSurface', () => {
  test('picks MCP when the app publishes one', () => {
    expect(pickSurface([variant('openapi', 'rest'), variant('mcp', 'mcp')])?.id).toBe('mcp');
  });
  test('an MCP surface without a template does not win', () => {
    expect(pickSurface([variant('mcp', 'mcp', false), variant('openapi', 'rest')])?.id).toBe(
      'rest',
    );
  });
  test('nothing installable is null', () => {
    expect(pickSurface([variant('cli', 'cli', false)])).toBeNull();
    expect(pickSurface([])).toBeNull();
  });
});

describe('surfaceInstallName', () => {
  const [primary, second] = installableVariants([
    variant('mcp', 'mcp'),
    variant('openapi', 'rest'),
  ]);
  const named = (name: string) => ({ ...second!, name });

  test('the primary surface is named from the app', () => {
    expect(surfaceInstallName('Resend', primary!, 0)).toBe('Resend');
  });
  test('every other surface is named from itself, qualified by the app', () => {
    expect(surfaceInstallName('Resend', second!, 1)).toBe('Resend rest surface');
    expect(surfaceInstallName('Resend', named('Surface 2'), 1)).toBe('Resend Surface 2');
    expect(surfaceInstallName('Resend', named('REST API'), 1)).toBe('Resend REST API');
  });
  test('a surface name that already starts with the app name is kept as is', () => {
    expect(surfaceInstallName('Resend', named('Resend REST API'), 1)).toBe('Resend REST API');
    expect(surfaceInstallName('Resend', named('  resend REST API '), 1)).toBe('resend REST API');
  });
  test('a blank surface name never takes the app name, which is the primary surface', () => {
    expect(surfaceInstallName('Resend', named(''), 1)).toBe('Resend 2');
    expect(surfaceInstallName('Resend', named('   '), 2)).toBe('Resend 3');
  });
  test('a surface named exactly as the app never takes the app name either', () => {
    expect(surfaceInstallName('Resend', named('Resend'), 1)).toBe('Resend 2');
  });
});
