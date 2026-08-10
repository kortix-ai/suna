// POST /projects/:id/manifest/validate historically always parsed `raw` as
// TOML, so a `kortix.yaml` project silently mis-parsed. This is a regression
// guard for the resolution rule: project manifestPath wins (via
// manifestFormatForPath), an explicit body `format` is the fallback for a
// project with no manifestPath on record, and `toml` is the last-resort
// default for back-compat.
import { describe, expect, test } from 'bun:test';
import { resolveManifestValidateFormat } from './manifest-format';

describe('resolveManifestValidateFormat', () => {
  test('derives yaml from a kortix.yaml manifestPath, ignoring a conflicting body format', () => {
    expect(resolveManifestValidateFormat('kortix.yaml', 'toml')).toBe('yaml');
  });

  test('derives yaml from a kortix.yml manifestPath', () => {
    expect(resolveManifestValidateFormat('config/kortix.yml', undefined)).toBe('yaml');
  });

  test('derives toml from a kortix.toml manifestPath', () => {
    expect(resolveManifestValidateFormat('kortix.toml', 'yaml')).toBe('toml');
  });

  test('falls back to an explicit body format when manifestPath is missing', () => {
    expect(resolveManifestValidateFormat(null, 'yaml')).toBe('yaml');
    expect(resolveManifestValidateFormat(undefined, 'yaml')).toBe('yaml');
    expect(resolveManifestValidateFormat('', 'yaml')).toBe('yaml');
  });

  test('defaults to toml when neither manifestPath nor a valid body format is given', () => {
    expect(resolveManifestValidateFormat(null, undefined)).toBe('toml');
    expect(resolveManifestValidateFormat(null, 'garbage')).toBe('toml');
  });
});
