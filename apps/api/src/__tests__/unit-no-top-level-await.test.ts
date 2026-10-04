import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

// A top-level `await` makes a module async. In this import graph that reorders
// module evaluation: a seed-regeneration block (`if (import.meta.main) { await
// fetch(...) }`) in services/llm-gateway/models/codex-models.ts turned an anonymous
// POST /turn-permission from 401 into 403 (flow PROJ-38). Entry points that
// nothing imports — src/app/index.ts and src/scripts/** — may await at top level.
const SRC = join(import.meta.dir, '..');
const ENTRY_POINTS = [/^app\/index\.ts$/, /^scripts\//];

function modules(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : modules(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

export function topLevelAwaitLines(source: string): number[] {
  const lines = source.split('\n');
  const hits: number[] = [];
  let mainBlock = false;
  lines.forEach((line, index) => {
    if (/^if \(import\.meta\.main\)/.test(line)) mainBlock = true;
    else if (mainBlock && /^\}/.test(line)) mainBlock = false;
    const topLevel = /^(await |for await|(export )?(const|let|var) [^=]+= await )/.test(line);
    if (topLevel || (mainBlock && /\bawait\b/.test(line))) hits.push(index + 1);
  });
  return hits;
}

describe('apps/api modules have no top-level await', () => {
  test('the detector catches both shapes and ignores awaits inside functions', () => {
    expect(topLevelAwaitLines('const x = await f();')).toEqual([1]);
    expect(topLevelAwaitLines('if (import.meta.main) {\n  const r = await fetch(u);\n}')).toEqual([2]);
    expect(topLevelAwaitLines('async function g() {\n  await f();\n}')).toEqual([]);
  });

  test('no imported module awaits at top level', () => {
    const offenders = modules(SRC)
      .map((path) => ({ file: relative(SRC, path), lines: topLevelAwaitLines(readFileSync(path, 'utf8')) }))
      .filter(({ file, lines }) => lines.length > 0 && !ENTRY_POINTS.some((entry) => entry.test(file)));
    expect(offenders).toEqual([]);
  });
});
