import { describe, expect, test } from 'bun:test';
import { createSessionCommandPayload } from '../store';
import type { CreateSessionCommand } from '../types';

describe('create session command payload', () => {
  test('preserves a service-account principal across durable queue persistence', () => {
    const now = new Date();
    const command = {
      source: 'ui',
      project: {
        projectId: crypto.randomUUID(),
        accountId: crypto.randomUUID(),
        name: 'Queue principal test',
        status: 'active',
        sandboxProviderGeneration: 0,
        repoUrl: 'https://example.test/queue-principal.git',
        defaultBranch: 'main',
        manifestPath: 'kortix.yaml',
        metadata: null,
        createdAt: now,
        updatedAt: now,
        lastOpenedAt: null,
      },
      userId: crypto.randomUUID(),
      requestingPrincipalType: 'service_account',
      body: { connector_bindings: {} },
    } satisfies CreateSessionCommand;

    expect(createSessionCommandPayload(command)).toMatchObject({
      requestingPrincipalType: 'service_account',
    });
  });
});
