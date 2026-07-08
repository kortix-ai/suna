import { describe, expect, test } from 'bun:test';

import {
  buildInstallSuccessSummary,
  capabilityCount,
  hasCapabilities,
  isInstallDisabled,
  projectMarketplaceHref,
} from './marketplace-install';

describe('buildInstallSuccessSummary', () => {
  test('singularizes "file" for a single-file install', () => {
    const summary = buildInstallSuccessSummary('Code Review', { file_count: 1 });

    expect(summary.title).toBe('Added Code Review');
    expect(summary.description).toBe('Committed 1 file — live in the next session.');
  });

  test('pluralizes "files" for multi-file installs', () => {
    const summary = buildInstallSuccessSummary('Bundle', { file_count: 4 });

    expect(summary.description).toBe('Committed 4 files — live in the next session.');
  });

  test('pluralizes for a zero-file install', () => {
    const summary = buildInstallSuccessSummary('Empty', { file_count: 0 });

    expect(summary.description).toBe('Committed 0 files — live in the next session.');
  });
});

describe('projectMarketplaceHref', () => {
  test('builds the customize marketplace deep link for a project', () => {
    expect(projectMarketplaceHref('proj_123')).toBe('/projects/proj_123/customize/marketplace');
  });

  test('URL-encodes project ids with special characters', () => {
    expect(projectMarketplaceHref('proj/weird id')).toBe(
      '/projects/proj%2Fweird%20id/customize/marketplace',
    );
  });
});

describe('hasCapabilities', () => {
  test('false for null/undefined', () => {
    expect(hasCapabilities(null)).toBe(false);
    expect(hasCapabilities(undefined)).toBe(false);
  });

  test('false when every list is empty', () => {
    expect(hasCapabilities({ secrets: [], connectors: [], tools: [], network: [] })).toBe(false);
  });

  test('true when any list is non-empty', () => {
    expect(hasCapabilities({ secrets: ['API_KEY'], connectors: [], tools: [], network: [] })).toBe(
      true,
    );
    expect(hasCapabilities({ secrets: [], connectors: ['slack'], tools: [], network: [] })).toBe(
      true,
    );
    expect(hasCapabilities({ secrets: [], connectors: [], tools: ['browser'], network: [] })).toBe(
      true,
    );
  });
});

describe('capabilityCount', () => {
  test('0 for null/undefined', () => {
    expect(capabilityCount(null)).toBe(0);
    expect(capabilityCount(undefined)).toBe(0);
  });

  test('sums across all three kinds', () => {
    expect(
      capabilityCount({
        secrets: ['A', 'B'],
        connectors: ['c'],
        tools: ['t1', 't2', 't3'],
        network: [],
      }),
    ).toBe(6);
  });
});

describe('isInstallDisabled', () => {
  test('disabled when no item is resolved', () => {
    expect(isInstallDisabled({ hasItem: false, targetProjectId: 'p1', pending: false })).toBe(true);
  });

  test('disabled when no target project is chosen', () => {
    expect(isInstallDisabled({ hasItem: true, targetProjectId: '', pending: false })).toBe(true);
  });

  test('disabled while a request is pending', () => {
    expect(isInstallDisabled({ hasItem: true, targetProjectId: 'p1', pending: true })).toBe(true);
  });

  test('enabled once an item, project, and idle state all line up', () => {
    expect(isInstallDisabled({ hasItem: true, targetProjectId: 'p1', pending: false })).toBe(false);
  });
});
