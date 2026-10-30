/**
 * `kortix schema` — print the canonical, public JSON Schema for `kortix.yaml`.
 *
 * ONE validator reference, three surfaces:
 *
 *   1. `https://kortix.com/schema/kortix.schema.json` — the document published
 *      at `apps/web/public/schema/` for editor `$schema` integration.
 *   2. This command — the CLI-local copy, for scripting / offline use /
 *      piping into `ajv` or another validator.
 *   3. `@kortix/manifest-schema`'s `manifestJsonSchema()` — what both of the
 *      above are generated from.
 */
import { KORTIX_SCHEMA_BASE_URL, manifestJsonSchema } from '@kortix/manifest-schema';
import { takeFlags } from '../command-argv.ts';
import { takeFlagBool } from '../command-helpers.ts';
import { C, help, status } from '../style.ts';

const HELP = help`Usage: kortix schema [options]

Print the canonical JSON Schema for kortix.yaml — the same document served at
${KORTIX_SCHEMA_BASE_URL}/kortix.schema.json. Point an editor's "$schema" at
that URL for live validation + autocomplete, or pipe this command's output
into ajv or any other JSON Schema validator.

Options:
  --url             Print the canonical URL instead of the schema body.
  -h, --help        Show this help.
`;

const SCHEMA_URL = `${KORTIX_SCHEMA_BASE_URL}/kortix.schema.json`;

export function runSchema(argv: string[]): number {
  const flags = takeFlags(
    argv,
    HELP,
    (rest) => ({ url: takeFlagBool(rest, ['--url']) }),
    (message) => {
      process.stderr.write(`${status.err(message)}\n`);
      return 1;
    },
  );
  if (typeof flags === 'number') return flags;

  if (flags.url) {
    process.stdout.write(`${SCHEMA_URL}\n`);
    return 0;
  }

  process.stderr.write(`${C.dim}# ${SCHEMA_URL}${C.reset}\n`);
  process.stdout.write(`${JSON.stringify(manifestJsonSchema(), null, 2)}\n`);
  return 0;
}
