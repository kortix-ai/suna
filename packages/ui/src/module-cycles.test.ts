import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

// No file-level import cycle crosses two top-level modules of src/. 2026-10-20:
// files/viewer re-exported FileViewer from session/panel, which imported files/viewer
// back, so './file-viewer' pulled 27 session files. Static, non-type imports only:
// a dynamic import() is lazy and breaks no load order.
const SRC = join(import.meta.dir);
const EXTS = ['.ts', '.tsx', '/index.ts', '/index.tsx'];
const STATIC = /(?:^|\n)\s*(?:import|export)\s+(?!type\b)(?:[^'";]*?\sfrom\s+)?['"](\.[^'"]+)['"]/g;

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'test-utils' || name === '__snapshots__' ? [] : walk(path);
    return /\.tsx?$/.test(name) && !/\.(test|d)\.tsx?$/.test(name) ? [path] : [];
  });

const files = walk(SRC);
const resolveFile = (from: string, spec: string) =>
  EXTS.map((ext) => join(dirname(from), spec) + ext)
    .concat(join(dirname(from), spec))
    .find((p) => /\.tsx?$/.test(p) && existsSync(p) && statSync(p).isFile());
const edges = new Map(
  files.map((file) => {
    const text = readFileSync(file, 'utf8').replace(/\bimport\s+type\b[^;]*;/g, '');
    const targets = [...text.matchAll(STATIC)].map((m) => resolveFile(file, m[1]!)).filter(Boolean) as string[];
    return [file, targets];
  }),
);
const moduleOf = (file: string) => relative(SRC, file).split('/')[0]!;

function stronglyConnected(): string[][] {
  let index = 0;
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const out: string[][] = [];
  const visit = (v: string) => {
    idx.set(v, index);
    low.set(v, index++);
    stack.push(v);
    onStack.add(v);
    for (const w of edges.get(v) ?? []) {
      if (!idx.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, idx.get(w)!));
    }
    if (low.get(v) === idx.get(v)) {
      const scc: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        scc.push(w);
      } while (w !== v);
      out.push(scc);
    }
  };
  for (const f of files) if (!idx.has(f)) visit(f);
  return out;
}

describe('module boundaries', () => {
  test('no import cycle spans two top-level modules', () => {
    const crossing = stronglyConnected()
      .filter((scc) => new Set(scc.map(moduleOf)).size > 1)
      .map((scc) => scc.map((f) => relative(SRC, f)).sort());
    expect(crossing).toEqual([]);
  });
});
