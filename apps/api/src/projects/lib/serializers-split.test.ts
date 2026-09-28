import { expect, test } from 'bun:test';
import { serializeBuildSummary, serializeTemplate } from '../../snapshots/serializers';
import { buildSecretView } from './secret-views';
import { normalizeBoolean, normalizeRepoUrl, parseBoundedPositiveInt } from './validators';

test('secret view keeps the delivery and personal-override contract', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  const row = {
    projectId: 'project',
    secretId: 'shared',
    name: 'EXAMPLE',
    strategy: 'egress',
    consumer: 'network',
    scope: 'runtime',
    active: true,
    createdAt: now,
    updatedAt: now,
    rotatedAt: null,
    egressPolicy: null,
    strategyLocked: false,
    createdBy: null,
  };
  const view = buildSecretView({
    identifier: 'EXAMPLE',
    name: 'EXAMPLE',
    shared: row as Parameters<typeof buildSecretView>[0]['shared'],
    personal: { ...row, secretId: 'personal' } as Parameters<typeof buildSecretView>[0]['personal'],
    canManageShared: true,
    agentGrants: { agent_discovery: 'opencode', agents: [] },
  });
  expect([
    view.effective_source,
    view.delivery_status,
    view.delivery_blocked_reason,
    view.requires_rotation,
    view.secret_id,
  ]).toEqual(['mine', 'available', 'no_agent_grant', true, 'shared']);
});

test('snapshot summaries preserve fallback classification and template identity', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  const build = {
    buildId: 'build',
    slug: 'default-warm',
    snapshotName: null,
    contentHash: null,
    status: 'failed',
    error: 'unknown failure',
    errorCategory: null,
    source: 'manual',
    provider: 'daytona',
    startedAt: now,
    finishedAt: null,
  };
  const summary = serializeBuildSummary(
    build as unknown as Parameters<typeof serializeBuildSummary>[0],
  );
  expect(summary.template_slug).toBe('default');
  expect(summary.started_at).toBe(now.toISOString());
  expect(summary.finished_at).toBeNull();
  const template = {
    templateId: 'template',
    slug: 'default',
    name: 'Default',
    providerCoverage: null,
  };
  expect(
    serializeTemplate(template as unknown as Parameters<typeof serializeTemplate>[0]),
  ).not.toHaveProperty('provider_coverage');
  expect(
    serializeTemplate({ ...template, providerCoverage: { daytona: true } } as unknown as Parameters<
      typeof serializeTemplate
    >[0]),
  ).toHaveProperty('provider_coverage');
});

test('generic validators retain boundary behavior', () => {
  expect(normalizeBoolean(' FALSE ')).toBe(false);
  expect(normalizeBoolean('yes')).toBeNull();
  expect(normalizeRepoUrl('https://github.com/example/repo.git///')).toBe(
    'https://github.com/example/repo.git',
  );
  expect(() => normalizeRepoUrl('http://github.com/example/repo')).toThrow();
  expect(parseBoundedPositiveInt('1.5', 2, 1, 10, 'limit')).toEqual({
    ok: false,
    error: 'limit must be an integer between 1 and 10',
  });
  expect(parseBoundedPositiveInt(undefined, 2, 1, 10, 'limit')).toEqual({ ok: true, value: 2 });
});
