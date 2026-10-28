// Shared by the docs generators that rewrite one marked region of a page
// (generate-kortix-yaml-doc.mjs, generate-cli-commands-doc.mjs) and by
// generate-audit-actions-doc.mjs, which reads the feature flag defaults.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

const registrySource = readFileSync(resolve(repositoryRoot, 'apps/api/src/feature-flags/registry.ts'), 'utf8');
const platformDefaults = new Map(
  [...registrySource.matchAll(/\n {4}key: '([a-z_]+)',[\s\S]*?\n {4}platformDefault: \(\) => ([^,\n]+),/g)].map(([, key, value]) => [key, value.trim()]),
);

/**
 * True when the feature flag is on for every new project (`platformDefault: () => true`).
 * The public docs leave out a feature whose flag is off by default (registry.ts header).
 * A default read from deployment config is off somewhere, so it counts as off.
 */
export function onByDefault(flag) {
  const value = platformDefaults.get(flag);
  if (value === undefined) throw new Error(`feature flag ${flag} is not in apps/api/src/feature-flags/registry.ts`);
  return value === 'true';
}

export const code = (value) => `\`${value}\``;

/** A table cell: no line break, `|` escaped, and no MDX expression or tag outside a code span. */
export function cell(text) {
  const value = String(text).replace(/\|/g, '\\|');
  if (/[{}<]/.test(value.replace(/`[^`]*`/g, ''))) throw new Error(`"${text}" has {, } or < outside a code span, which MDX reads as code`);
  if (/\n/.test(value)) throw new Error(`"${text}" has a line break`);
  return value;
}

/**
 * Rewrites the text between `{/* generated:<name>:start *\/}` and `{/* generated:<name>:end *\/}`.
 * Arguments: [file] (default apps/web/content/docs/developers.mdx) and --check, which exits 1
 * when the region is stale instead of writing it.
 */
export async function runRegionGenerator(name, script, render) {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const page = resolve(repositoryRoot, 'apps/web/content/docs/developers.mdx');
  const target = resolve(args.find((arg) => arg !== '--check') ?? page);
  const start = `{/* generated:${name}:start */}`;
  const end = `{/* generated:${name}:end */}`;
  const text = readFileSync(target, 'utf8');
  const from = text.indexOf(start);
  const to = text.indexOf(end);
  if (from < 0 || to < from) {
    console.error(`${target} has no ${start} … ${end} region.`);
    process.exit(1);
  }
  const next = `${text.slice(0, from + start.length)}\n\n${await render()}\n\n${text.slice(to)}`;
  if (!check) {
    writeFileSync(target, next);
    console.log(`Wrote the ${name} region of ${target}`);
  } else if (next !== text) {
    console.error(`The ${name} region of ${target} is stale. Run: bun ${script}${target === page ? '' : ` ${target}`}`);
    process.exit(1);
  }
}
