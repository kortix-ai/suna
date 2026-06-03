/**
 * Snapshot the starter template tree into `src/embedded.generated.json`.
 *
 * The runtime loader (`src/index.ts`) walks the template directories on disk
 * when they exist (the normal `bun run` / source-checkout path, so editing a
 * template is just editing a file). That walk does NOT survive
 * `bun build --compile`: the compiler cannot statically analyze a recursive
 * `readdirSync`, so none of `templates/` ends up in the embedded `$bunfs`,
 * and `kortix init` from the compiled binary fails with ENOENT.
 *
 * This script produces a statically-importable JSON snapshot of every
 * template file (raw, with `{{var}}` placeholders intact). A static JSON
 * import IS inlined into the compiled binary, so the loader falls back to it
 * when the on-disk templates are unavailable.
 *
 * Run it directly (`bun run scripts/generate-embedded.ts`) or let the CLI
 * build regenerate it before compiling. `scaffold.test.ts` asserts the
 * snapshot is in sync so a stale commit fails CI.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

// Computed independently of src/index.ts so this script never imports the
// module that (in turn) imports the file we are about to generate.
const STARTER_ROOT = join(import.meta.dir, '..');
const TEMPLATE_ROOTS = {
  base: join(STARTER_ROOT, 'templates', 'base'),
  'general-knowledge-worker': join(STARTER_ROOT, 'templates', 'general-knowledge-worker'),
} as const;

interface RawFile {
  path: string;
  content: string;
}

function walk(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const abs = join(root, entry);
    const st = statSync(abs);
    if (st.isDirectory()) out.push(...walk(abs));
    else if (st.isFile()) out.push(abs);
  }
  return out;
}

function rawFiles(root: string): RawFile[] {
  return walk(root)
    .map((abs) => ({
      path: relative(root, abs).split(sep).join('/'),
      content: readFileSync(abs, 'utf8'),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

export function buildEmbeddedSnapshot(): Record<string, { files: RawFile[] }> {
  const out: Record<string, { files: RawFile[] }> = {};
  for (const [name, dir] of Object.entries(TEMPLATE_ROOTS)) {
    out[name] = { files: rawFiles(dir) };
  }
  return out;
}

const OUTPUT_PATH = join(STARTER_ROOT, 'src', 'embedded.generated.json');

if (import.meta.main) {
  const snapshot = buildEmbeddedSnapshot();
  writeFileSync(OUTPUT_PATH, JSON.stringify(snapshot) + '\n', 'utf8');
  const total = Object.values(snapshot).reduce((n, r) => n + r.files.length, 0);
  process.stdout.write(`Wrote ${OUTPUT_PATH} (${total} files)\n`);
}
