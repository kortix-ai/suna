/**
 * The manifest version ceilings must not drift.
 *
 * There are THREE of them, in three packages, and they are deliberately
 * separate constants (import cycles). When `kortix_version: 3` was added to
 * `@kortix/manifest-schema` and the other two were left at 2, every v3 project
 * still booted — the pi path parses the manifest itself — while silently
 * losing every grant, every trigger, and every manifest write, because the
 * runtime reader threw and its callers swallow the throw into an empty result.
 *
 * A drift test is the only thing that catches that, because no single package's
 * own suite can see the other two.
 */
import { describe, expect, test } from 'bun:test';
import { KNOWN_SCHEMA_VERSION as SCHEMA_PACKAGE_CEILING } from '@kortix/manifest-schema';
import { MAX_SCHEMA_VERSION } from '../projects/triggers';
import { LATEST_MANIFEST_VERSION } from '../projects/lib/manifest-verdict';

describe('manifest schema version ceilings', () => {
  test('the runtime reader accepts everything the schema package can validate', () => {
    // `<` would be the bug: a manifest that `kortix validate` accepts and this
    // reader refuses is one the platform writes and then cannot read.
    expect(MAX_SCHEMA_VERSION).toBe(SCHEMA_PACKAGE_CEILING);
  });

  test('the version reported to users is the one the platform actually ships', () => {
    expect(LATEST_MANIFEST_VERSION).toBe(SCHEMA_PACKAGE_CEILING);
  });

  test('the ceiling is a real integer version, not a placeholder', () => {
    expect(Number.isInteger(MAX_SCHEMA_VERSION)).toBe(true);
    expect(MAX_SCHEMA_VERSION).toBeGreaterThanOrEqual(3);
  });
});
