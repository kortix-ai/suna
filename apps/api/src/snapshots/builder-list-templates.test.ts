/**
 * Regression coverage for `listSandboxTemplates` resilience against individual
 * template failures.
 *
 * Incident: Better Stack Frontend error (pattern b82b59c0…)
 *   "Failed to list sandbox templates: Sandbox template "kortix-dockerfile-sandbox":
 *    Dockerfile ... is empty"
 *
 * Root cause: `resolveUserDockerfile` in `templates.ts` throws when a template's
 * Dockerfile is empty (or becomes empty after `normalizeUserDockerfileForSnapshot`
 * strips the legacy starter block). The old `listSandboxTemplates` used
 * `Promise.all([…].map(toView))`, so a single broken template failed the ENTIRE
 * listing — returning a 500 to the frontend that surfaced as a Sentry `ApiError`.
 *
 * Fix: use `Promise.allSettled` and `console.warn`-skip templates that fail
 * resolution, returning the healthy subset.
 */
import { describe, expect, mock, test } from 'bun:test';
import { listSandboxTemplates, type SandboxTemplateView } from './builder';
import * as realSnapshotProviders from './providers';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const HEALTHY_TEMPLATE = {
  templateId: 'tpl-1',
  projectId: 'proj-1',
  slug: 'default',
  name: 'Default',
  isShared: true,
  source: 'platform' as const,
  provider: 'daytona',
  image: null,
  dockerfilePath: null,
  entrypoint: null,
  cpu: 1,
  memoryGb: 2,
  diskGb: 10,
  providerState: 'active',
  providerSnapshotName: 'kortix-default-abc',
  contentHash: 'a'.repeat(64),
  builtFromCommit: null,
  swapKey: null,
};

const BROKEN_TEMPLATE = {
  ...HEALTHY_TEMPLATE,
  templateId: 'tpl-2',
  slug: 'kortix-dockerfile-sandbox',
  name: 'Dockerfile Sandbox',
  isShared: false,
  source: 'toml' as const,
  dockerfilePath: 'Dockerfile',
  image: null,
};

const ANOTHER_HEALTHY_TEMPLATE = {
  ...HEALTHY_TEMPLATE,
  templateId: 'tpl-3',
  slug: 'python-3-12',
  name: 'Python 3.12',
  isShared: false,
  source: 'ui' as const,
  image: 'python:3.12-slim',
  dockerfilePath: null,
};

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockTemplatesList: any[] = [];

mock.module('./templates', () => ({
  listTemplatesForProject: async () => mockTemplatesList,
  computeTemplateIdentity: async (_project: any, template: any) => {
    // Simulate the exact error from resolveUserDockerfile when the Dockerfile
    // is empty or gets stripped to empty by normalizeUserDockerfileForSnapshot.
    if (template.slug === 'kortix-dockerfile-sandbox') {
      throw new Error(
        `Sandbox template "${template.slug}": Dockerfile ${template.dockerfilePath} is empty`,
      );
    }
    return {
      snapshotName: `kortix-tpl-${template.slug}-abc123`,
      contentHash: 'a'.repeat(64),
      shortHash: 'abc123',
      runtimeFingerprint: 'test-runtime-fp',
      userDockerfile: 'FROM ubuntu:24.04\n',
      builtFromCommit: null,
      swapKey: 'test-swap-key',
    };
  },
  recordTemplateBuilt: async () => {},
  recordTemplateFailed: async () => {},
  refreshTemplateState: async () => {},
  resolveTemplateBySlug: async () => HEALTHY_TEMPLATE,
  resolveTemplateForBuildSlug: async () => HEALTHY_TEMPLATE,
}));

mock.module('../config', () => ({
  config: {
    isProviderEnabled: () => true,
    sandboxProvider: 'daytona',
    host: 'test',
  },
}));

const mockProvider = {
  isConfigured: () => true,
  getSnapshotState: async () => 'active',
};

// Spread the real module: `mock.module` replaces it WHOLESALE, so a stub that
// lists exports by hand deletes every export it omits — the failure surfaces in
// whatever unrelated file imports the missing name next, attributed to no test.
mock.module('./providers', () => ({
  ...realSnapshotProviders,
  getSandboxProvider: () => mockProvider,
}));

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('listSandboxTemplates resilience', () => {
  test('returns all templates when all are healthy', async () => {
    mockTemplatesList.length = 0;
    mockTemplatesList.push(HEALTHY_TEMPLATE, ANOTHER_HEALTHY_TEMPLATE);

    const result = await listSandboxTemplates({} as any, {});
    expect(result).toHaveLength(2);
    expect(result[0]!.slug).toBe('default');
    expect(result[1]!.slug).toBe('python-3-12');
  });

  test('skips a broken template and returns the rest', async () => {
    mockTemplatesList.length = 0;
    mockTemplatesList.push(HEALTHY_TEMPLATE, BROKEN_TEMPLATE, ANOTHER_HEALTHY_TEMPLATE);

    const result = await listSandboxTemplates({} as any, {});
    // The broken template should be skipped, returning the two healthy ones
    expect(result).toHaveLength(2);
    expect(result[0]!.slug).toBe('default');
    expect(result[1]!.slug).toBe('python-3-12');
  });

  test('returns empty array when ALL templates are broken', async () => {
    mockTemplatesList.length = 0;
    mockTemplatesList.push(BROKEN_TEMPLATE);

    const result = await listSandboxTemplates({} as any, {});
    expect(result).toHaveLength(0);
  });

  test('returns empty array when there are no templates', async () => {
    mockTemplatesList.length = 0;

    const result = await listSandboxTemplates({} as any, {});
    expect(result).toHaveLength(0);
  });

  test('does not throw from a broken template — the error is caught and logged', async () => {
    mockTemplatesList.length = 0;
    mockTemplatesList.push(BROKEN_TEMPLATE);

    // listSandboxTemplates should never throw — it catches per-template errors
    await expect(
      listSandboxTemplates({} as any, {}),
    ).resolves.toBeDefined();
  });
});