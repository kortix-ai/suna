/**
 * Rule 5 (spec §3): "A turn that cannot run because the box's model map lacks
 * the requested model must fail with an error that NAMES that cause and
 * carries both fingerprints." Today it is `500 {"name":"UnknownError","ref":"err_…"}`
 * — this function decides whether THAT specific opaque body, for THIS
 * session, is explainable by a stale catalog fingerprint, and if so produces
 * the named replacement. It never invents a cause it cannot support: any
 * other shape, or a session whose catalog already matches, passes through
 * unnamed (null) so the original bytes reach the client unchanged.
 */
import { describe, expect, test } from 'bun:test';
import { nameStaleModelCatalogError } from '../name-stale-catalog-error';
import { UNREPORTED_ACTUAL_RUNTIME } from '../actual';

const DESIRED_DEPS = {
  desiredRuntime: async () => ({
    release_id: null,
    catalog_fingerprint: 'cat_current',
    daemon_build: 100,
    cli_sha256: 'c'.repeat(64),
    managed_skills_hash: 'm'.repeat(64),
  }),
};

describe('nameStaleModelCatalogError', () => {
  test('names the cause when the body is UnknownError and the box catalog is stale', async () => {
    const named = await nameStaleModelCatalogError(
      '{"name":"UnknownError","ref":"err_abc123"}',
      {
        ...DESIRED_DEPS,
        actualRuntime: async () => ({ ...UNREPORTED_ACTUAL_RUNTIME, catalog_fingerprint: 'cat_stale' }),
      },
    );
    expect(named).not.toBeNull();
    expect(named?.code).toBe('SESSION_MODEL_CATALOG_STALE');
    expect(named?.desired_catalog_fingerprint).toBe('cat_current');
    expect(named?.actual_catalog_fingerprint).toBe('cat_stale');
    expect(named?.error).toContain('catalog');
  });

  test('passes through (null) when the catalog fingerprints already match — not our cause to name', async () => {
    const named = await nameStaleModelCatalogError(
      '{"name":"UnknownError","ref":"err_abc123"}',
      {
        ...DESIRED_DEPS,
        actualRuntime: async () => ({ ...UNREPORTED_ACTUAL_RUNTIME, catalog_fingerprint: 'cat_current' }),
      },
    );
    expect(named).toBeNull();
  });

  test('passes through (null) for a body that is not UnknownError at all', async () => {
    const named = await nameStaleModelCatalogError(
      '{"name":"SomeOtherError","message":"disk full"}',
      { ...DESIRED_DEPS, actualRuntime: async () => ({ ...UNREPORTED_ACTUAL_RUNTIME, catalog_fingerprint: 'cat_stale' }) },
    );
    expect(named).toBeNull();
  });

  test('passes through (null) for a body that is not JSON at all — never throws', async () => {
    const named = await nameStaleModelCatalogError('not json', {
      ...DESIRED_DEPS,
      actualRuntime: async () => ({ ...UNREPORTED_ACTUAL_RUNTIME, catalog_fingerprint: 'cat_stale' }),
    });
    expect(named).toBeNull();
  });

  test('a box that reports no catalog fingerprint at all cannot be named as stale either — no evidence either way', async () => {
    const named = await nameStaleModelCatalogError(
      '{"name":"UnknownError","ref":"err_abc123"}',
      { ...DESIRED_DEPS, actualRuntime: async () => UNREPORTED_ACTUAL_RUNTIME },
    );
    expect(named).toBeNull();
  });
});
