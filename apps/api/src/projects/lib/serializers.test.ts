import { describe, expect, test } from 'bun:test';

import { serializeProject } from './serializers';

function projectRow(metadata: Record<string, unknown>) {
  return {
    projectId: '11111111-1111-4111-8111-111111111111',
    accountId: '22222222-2222-4222-8222-222222222222',
    name: 'demo',
    repoUrl: 'https://github.com/acme/demo.git',
    defaultBranch: 'main',
    manifestPath: 'kortix.yaml',
    status: 'active' as const,
    secretDefaultStrategy: 'runtime' as const,
    metadata,
    sandboxProviderGeneration: 0,
    lastOpenedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  };
}

describe('serializeProject icon', () => {
  test('exposes a valid metadata.icon as a top-level field', () => {
    expect(serializeProject(projectRow({ icon: '🚀' }) as never).icon).toBe('🚀');
  });

  test('is null when metadata has no icon', () => {
    expect(serializeProject(projectRow({}) as never).icon).toBeNull();
  });

  test('is null when metadata.icon is malformed', () => {
    expect(serializeProject(projectRow({ icon: 'not-an-emoji' }) as never).icon).toBeNull();
  });

  test('is null when metadata.icon is oversized', () => {
    expect(serializeProject(projectRow({ icon: 'x'.repeat(5000) }) as never).icon).toBeNull();
  });
});
