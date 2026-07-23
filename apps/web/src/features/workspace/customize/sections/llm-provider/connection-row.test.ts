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
    expect(catalogLine(conn({ catalogState: 'available', modelCount: 1 }))).toBe(
      '1 model available',
    );
    expect(catalogLine(conn({ catalogState: 'available', modelCount: 12 }))).toBe(
      '12 models available',
    );
  });

  test('renders harness-owned copy when the catalog is not exposed', () => {
    expect(catalogLine(conn({ kind: 'claude_subscription', catalogState: 'not-exposed' }))).toBe(
      'Models managed by Claude Code',
    );
    expect(catalogLine(conn({ kind: 'codex_subscription', catalogState: 'not-exposed' }))).toBe(
      'Models managed by Codex',
    );
    expect(catalogLine(conn({ kind: 'native_config', catalogState: 'not-exposed' }))).toBe(
      "Uses the repo's committed setup",
    );
  });

  test('renders loading/error states', () => {
    expect(catalogLine(conn({ catalogState: 'loading' }))).toBe('Loading models…');
    expect(catalogLine(conn({ catalogState: 'error' }))).toBe('Could not load models');
  });
});

describe('metadataLine', () => {
  test('names Kortix as the home of the default model, no used-by clause', () => {
    expect(metadataLine(conn({ kind: 'managed_gateway', usedBy: [] }))).toBe(
      'Included · 12 models available · sets your default model',
    );
    // "Used by …" is deliberately gone — the agent rows above already say which
    // agent runs on what, so the service row never echoes it back (that mutual
    // cross-reference was the confusing part of the old two-list page).
    expect(metadataLine(conn({ kind: 'managed_gateway', usedBy: ['opencode'] }))).toBe(
      'Included · 12 models available · sets your default model',
    );
  });

  test('BYOK connections describe only the models they unlock, never a used-by clause', () => {
    expect(metadataLine(conn({ kind: 'anthropic_api_key', usedBy: [], modelCount: 8 }))).toBe(
      '8 models available',
    );
    expect(
      metadataLine(conn({ kind: 'anthropic_api_key', usedBy: ['claude', 'pi'], modelCount: 8 })),
    ).toBe('8 models available');
  });

  test('needs-attention connections lead with the status reason regardless of kind', () => {
    expect(
      metadataLine(
        conn({ kind: 'managed_gateway', status: 'needs-attention', statusReason: 'Token expired' }),
      ),
    ).toBe('Needs attention · Token expired');
    expect(
      metadataLine(
        conn({ kind: 'anthropic_api_key', status: 'needs-attention', statusReason: null }),
      ),
    ).toBe('Needs attention · Reconnect to continue');
  });
});
