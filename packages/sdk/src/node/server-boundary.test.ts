import { test, expect } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { existsSync } from 'node:fs';

// Bun's module parser reports actual runtime imports, excluding type-only edges.
test('server entrypoint is not a runtime dependency of its implementations', async () => {
  const server = resolve(import.meta.dir, 'server.ts');
  const visited = new Set<string>();
  const pending = ['auth.ts', 'app-viewer.ts', 'app-guard.ts'].map((file) => resolve(import.meta.dir, file));
  while (pending.length) {
    const file = pending.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    const imports = new Bun.Transpiler({ loader: 'ts' }).scanImports(await readFile(file, 'utf8'));
    for (const entry of imports) {
      if (!entry.path.startsWith('.')) continue;
      const base = resolve(dirname(file), entry.path);
      const target = [`${base}.ts`, resolve(base, 'index.ts')].find(existsSync);
      if (!target) continue;
      expect(target).not.toBe(server);
      pending.push(target);
    }
  }
});
