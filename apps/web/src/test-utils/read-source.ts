import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const UI_PACKAGE = join(import.meta.dir, '..', '..', '..', '..', 'packages', 'ui');
const UI_EXPORTS: Record<string, unknown> = JSON.parse(
  readFileSync(join(UI_PACKAGE, 'package.json'), 'utf8'),
).exports;
const SHIM = /^\s*(?:['"]use client['"];?\s*)?(?:export (?:\*|\{ default \}) from '@kortix\/ui(?:\/[^']+)?';\s*)+$/;
const SHIM_TARGET = /from '@kortix\/ui(\/[^']+)?'/;

/**
 * A source file's text, for tests that read source. An apps/web file that moved
 * to @kortix/ui is a one-line `export * from '@kortix/ui/<path>'` (or
 * `export { default } from …`) shim: this reads the package file it re-exports instead.
 */
export function readSource(path: string): string {
  const source = readFileSync(path, 'utf8');
  if (!SHIM.test(source)) return source;
  const target = UI_EXPORTS[`.${source.match(SHIM_TARGET)?.[1] ?? ''}`];
  return typeof target === 'string' ? readFileSync(join(UI_PACKAGE, target), 'utf8') : source;
}
