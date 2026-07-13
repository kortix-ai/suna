import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = resolve(import.meta.dir, '../../../..');
const forbiddenVendor = ['free', 'style'].join('');
const forbiddenCapabilityIdentifiers = [
  'KORTIX_APPS_EXPERIMENTAL',
  'NEXT_PUBLIC_KORTIX_DEPLOYMENTS_ENABLED',
  'style.dev',
  'freestyleId',
  'legacy-freestyle',
  'project.deploy',
  'project.read|write|delete|deploy',
  'serializeDeploymentRow',
  'apps-config',
  'projects-apps-client',
  'apps-overlay-store',
  'use-apps-enabled',
  'use-project-apps',
  'use-deployments',
  'deploymentStatusEnum',
  'deploymentSourceEnum',
  'deploymentsRelations',
  'NewDeployment',
  'DeploymentSelect',
];
const immutableSchemaHistoryPrefixes = [
  'packages/db/drizzle/',
  'packages/db/migrations/',
];
const trackingFiles = new Set([
  'packages/sdk/PROGRESS.md',
  'apps/api/src/__tests__/unit-hosted-deployment-vendor-removal.test.ts',
]);

function trackedTextFiles(): string[] {
  const result = Bun.spawnSync(['git', 'ls-files', '-z'], { cwd: repoRoot });
  expect(result.exitCode).toBe(0);
  return result.stdout
    .toString()
    .split('\0')
    .filter(Boolean)
    .filter((file) => existsSync(resolve(repoRoot, file)))
    .filter((file) => !trackingFiles.has(file))
    .filter(
      (file) => !immutableSchemaHistoryPrefixes.some((prefix) => file.startsWith(prefix)),
    );
}

describe('retired hosted deployment vendor', () => {
  test('has no active tracked vendor references', () => {
    const matches = trackedTextFiles().filter((file) => {
      const content = readFileSync(resolve(repoRoot, file));
      return (
        !content.includes(0) &&
        content.toString('utf8').toLowerCase().includes(forbiddenVendor)
      );
    });

    expect(matches).toEqual([]);
  });

  test('has no active tracked capability identifiers', () => {
    const matches = trackedTextFiles().flatMap((file) => {
      const content = readFileSync(resolve(repoRoot, file));
      if (content.includes(0)) return [];
      const text = content.toString('utf8');
      return forbiddenCapabilityIdentifiers
        .filter((identifier) => text.includes(identifier))
        .map((identifier) => `${file}: ${identifier}`);
    });

    expect(matches).toEqual([]);
  });
});
