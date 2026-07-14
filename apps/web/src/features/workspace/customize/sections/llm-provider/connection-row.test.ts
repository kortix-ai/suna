import { describe, expect, test } from 'bun:test';

import type { ModelsPageConnection } from '@kortix/sdk/react';
import { catalogLine, metadataLine } from './connection-row';

function conn(overrides: Partial<ModelsPageConnection>): ModelsPageConnection {
  return {
    id: 'managed_gateway',
    name: 'Kortix',
    kind: 'managed_gateway',
    status: 'ready',
    usedBy: [],
    catalogState: 'available',
    modelCount: 12,
    statusReason: null,
    ...overrides,
  };
}

describe('catalogLine', () => {
  test('renders the model count for an available catalog', () => {
    expect(catalogLine(conn({ catalogState: 'available', modelCount: 1 }))).toBe('1 model available');
    expect(catalogLine(conn({ catalogState: 'available', modelCount: 12 }))).toBe('12 models available');
  });

  test('renders harness-owned copy when the catalog is not exposed', () => {
    expect(
      catalogLine(conn({ kind: 'claude_subscription', catalogState: 'not-exposed' })),
    ).toBe('Models managed by Claude Code');
    expect(
      catalogLine(conn({ kind: 'codex_subscription', catalogState: 'not-exposed' })),
    ).toBe('Models managed by Codex');
    expect(
      catalogLine(conn({ kind: 'native_config', catalogState: 'not-exposed' })),
    ).toBe('Model catalog not exposed');
  });

  test('renders loading/error states', () => {
    expect(catalogLine(conn({ catalogState: 'loading' }))).toBe('Loading models…');
    expect(catalogLine(conn({ catalogState: 'error' }))).toBe('Could not load models');
  });
});

describe('metadataLine', () => {
  test('leads with "Included with Kortix" for the managed gateway instead of a used-by clause', () => {
    expect(metadataLine(conn({ kind: 'managed_gateway', usedBy: [] }))).toBe(
      'Included with Kortix · 12 models available',
    );
    expect(metadataLine(conn({ kind: 'managed_gateway', usedBy: ['opencode'] }))).toBe(
      'Included with Kortix · 12 models available',
    );
  });

  test('BYOK connections still read "Used by …" / "Not currently used"', () => {
    expect(
      metadataLine(conn({ kind: 'anthropic_api_key', usedBy: [], modelCount: 8 })),
    ).toBe('Not currently used · 8 models available');
    expect(
      metadataLine(conn({ kind: 'anthropic_api_key', usedBy: ['claude', 'pi'], modelCount: 8 })),
    ).toBe('Used by Claude Code and Pi · 8 models available');
  });

  test('needs-attention connections lead with the status reason regardless of kind', () => {
    expect(
      metadataLine(
        conn({ kind: 'managed_gateway', status: 'needs-attention', statusReason: 'Token expired' }),
      ),
    ).toBe('Needs attention · Token expired');
    expect(metadataLine(conn({ kind: 'anthropic_api_key', status: 'needs-attention', statusReason: null }))).toBe(
      'Needs attention · Reconnect to continue',
    );
  });
});
