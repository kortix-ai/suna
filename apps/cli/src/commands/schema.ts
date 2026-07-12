/**
 * `kortix schema` — print the canonical, public JSON Schema for
 * `kortix.toml` / `kortix.yaml`.
 *
 * ONE validator reference, three surfaces:
 *
 *   1. `https://kortix.com/schema/kortix{,.v1,.v2}.schema.json` — the same
 *      documents published at `apps/web/public/schema/` for editor
 *      `$schema` integration.
 *   2. This command — the CLI-local copy, for scripting / offline use /
 *      piping into `ajv` or another validator.
 *   3. `@kortix/manifest-schema`'s `manifestJsonSchema()` — what both of the
 *      above are generated from.
 *
 * All three read the exact same in-code export, so there is no drift
 * between "the schema the CLI prints" and "the schema the URL serves."
 */
import { KORTIX_SCHEMA_BASE_URL, manifestJsonSchema } from '@kortix/manifest-schema';
import { C, help, status } from '../style.ts';

const HELP = help`Usage: kortix schema [options]

Print the canonical JSON Schema for kortix.toml / kortix.yaml — the same
document served at ${KORTIX_SCHEMA_BASE_URL}/kortix.v2.schema.json (and the
v1 / combined variants). Point an editor's "$schema" at that URL for live
validation + autocomplete, or pipe this command's output into ajv or any
other JSON Schema validator.

Options:
  --version <1|2>   Print only that schema version (default: the combined
                     document, which dispatches on kortix_version).
  --url             Print the canonical URL for the selected version instead
                     of the schema body.
  -h, --help        Show this help.
`;

interface Flags {
  version?: 1 | 2;
  url: boolean;
  help: boolean;
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { url: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--version') {
      const next = argv[++i];
      if (next !== '1' && next !== '2') {
        throw new Error(`--version must be "1" or "2" (got ${JSON.stringify(next)}).`);
      }
      flags.version = next === '1' ? 1 : 2;
    } else if (arg === '--url') {
      flags.url = true;
    } else if (arg === '-h' || arg === '--help') {
      flags.help = true;
    } else {
      throw new Error(`unknown option "${arg}"`);
    }
  }
  return flags;
}

function schemaFilename(version?: 1 | 2): string {
  if (version === 1) return 'kortix.v1.schema.json';
  if (version === 2) return 'kortix.v2.schema.json';
  return 'kortix.schema.json';
}

export function runSchema(argv: string[]): number {
  let flags: Flags;
  try {
    flags = parseFlags(argv);
  } catch (err) {
    process.stderr.write(`${status.err(err instanceof Error ? err.message : String(err))}\n`);
    return 1;
  }
  if (flags.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const url = `${KORTIX_SCHEMA_BASE_URL}/${schemaFilename(flags.version)}`;
  if (flags.url) {
    process.stdout.write(`${url}\n`);
    return 0;
  }

  const schema = manifestJsonSchema(flags.version ?? 'combined');
  process.stderr.write(`${C.dim}# ${url}${C.reset}\n`);
  process.stdout.write(`${JSON.stringify(schema, null, 2)}\n`);
  return 0;
}
