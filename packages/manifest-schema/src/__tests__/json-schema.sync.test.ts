/**
 * Guards `apps/web/public/schema/*.json` (the PUBLIC, served copies of the
 * schema) against drifting from the in-code export. Mirrors the same
 * anti-drift pattern as `packages/starter/src/__tests__/embedded.test.ts`
 * for the starter's embedded snapshot: run the generator, diff its output
 * against the committed files, fail loudly on any mismatch instead of
 * silently serving a stale schema.
 *
 * If this fails after a legitimate schema change: run
 * `bun run generate:schema` (from `packages/manifest-schema`) and commit
 * the result.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderSchemaFile, SCHEMA_FILES, SCHEMA_OUT_DIR } from '../../scripts/generate-schema';

describe('apps/web/public/schema/*.json — committed files match the generated export', () => {
  for (const [filename, schema] of Object.entries(SCHEMA_FILES)) {
    test(`${filename} is in sync`, () => {
      const path = join(SCHEMA_OUT_DIR, filename);
      expect(existsSync(path)).toBe(true);
      const onDisk = readFileSync(path, 'utf8');
      expect(onDisk).toBe(renderSchemaFile(schema));
    });
  }
});
