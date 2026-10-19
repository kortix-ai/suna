import { readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lineNumber, sourceFiles } from '../../../scripts/lib/sdk-boundary-scan.mjs';
import { scanSource as scanWhiteLabelSource } from '../../whitelabel-demo/scripts/sdk-boundary.mjs';

/**
 * The internal app's boundary: the white-label rules (no OpenCode SDK, no
 * runtime internals, no hand-built runtime URLs, controls from @kortix/ui, no
 * second UI kit, ...) plus two stricter ones. This app has no backend, so it
 * has no fetch at all, and it imports only the curated one-segment
 * @kortix/ui entries, never a deep path.
 */
const APP_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC = join(APP_ROOT, 'src');

const RULES = [
  {
    rule: 'any-fetch',
    pattern: /\bfetch\s*\(/g,
    message: 'No fetch: every Kortix call goes through the @kortix/sdk client in src/kortix.ts.',
  },
  {
    rule: 'deep-ui-entry',
    pattern: /['"]@kortix\/ui\/[^'"/]+\/[^'"]+['"]/g,
    message: 'Import a curated @kortix/ui/<module> entry, never a deep path.',
  },
];

export function scanSource(source) {
  const own = RULES.flatMap(({ rule, pattern, message }) =>
    [...source.matchAll(pattern)].map((m) => ({ rule, index: m.index, message })),
  );
  // The white-label fetch rule allows its own BFF routes; `any-fetch` replaces it here.
  const shared = scanWhiteLabelSource(source, { client: true }).filter((v) => v.rule !== 'raw-kortix-fetch');
  return [...own, ...shared].sort((a, b) => a.index - b.index);
}

function run() {
  const violations = sourceFiles(SRC, { extensions: new Set(['.ts', '.tsx']) }).flatMap((path) => {
    const source = readFileSync(path, 'utf8');
    return scanSource(source).map((v) => ({ ...v, file: relative(APP_ROOT, path), line: lineNumber(source, v.index) }));
  });
  for (const v of violations) console.error(`${v.file}:${v.line} [${v.rule}] ${v.message}`);
  console.log(`Internal app SDK boundary: ${violations.length} violation(s).`);
  if (violations.length > 0) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) run();
