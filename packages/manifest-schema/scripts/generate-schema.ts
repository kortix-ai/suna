/**
 * Writes the canonical, PUBLIC JSON Schema documents to
 * `apps/web/public/schema/` so the web app serves them at a stable URL
 * (`https://<host>/schema/kortix.v2.schema.json`, etc.) with zero drift from
 * the code: the ONLY input to this script is `./src/json-schema.ts`, which
 * is itself built from the same constants/enums the imperative validator
 * (`./src/index.ts`) uses.
 *
 * Run directly (`bun run scripts/generate-schema.ts`, or
 * `bun run generate:schema`). `json-schema.sync.test.ts` asserts the
 * committed files are byte-identical to what this script would produce, so a
 * stale commit fails CI the same way a stale starter snapshot does
 * (`packages/starter/scripts/generate-embedded.ts`).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  KORTIX_JSON_SCHEMA,
  KORTIX_V1_JSON_SCHEMA,
  KORTIX_V2_JSON_SCHEMA,
  KORTIX_V3_JSON_SCHEMA,
} from '../src/json-schema';

const MANIFEST_SCHEMA_ROOT = join(import.meta.dir, '..');
export const SCHEMA_OUT_DIR = join(MANIFEST_SCHEMA_ROOT, '..', '..', 'apps', 'web', 'public', 'schema');

export const SCHEMA_FILES: Record<string, unknown> = {
  'kortix.schema.json': KORTIX_JSON_SCHEMA,
  'kortix.v1.schema.json': KORTIX_V1_JSON_SCHEMA,
  'kortix.v2.schema.json': KORTIX_V2_JSON_SCHEMA,
  'kortix.v3.schema.json': KORTIX_V3_JSON_SCHEMA,
};

export function renderSchemaFile(schema: unknown): string {
  return `${JSON.stringify(schema, null, 2)}\n`;
}

if (import.meta.main) {
  mkdirSync(SCHEMA_OUT_DIR, { recursive: true });
  for (const [filename, schema] of Object.entries(SCHEMA_FILES)) {
    writeFileSync(join(SCHEMA_OUT_DIR, filename), renderSchemaFile(schema), 'utf8');
  }
  process.stdout.write(
    `Wrote ${Object.keys(SCHEMA_FILES).length} schema file(s) to ${SCHEMA_OUT_DIR}\n`,
  );
}
