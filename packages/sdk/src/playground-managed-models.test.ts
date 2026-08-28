import { expect, test } from 'bun:test';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

const playgroundRoot = join(import.meta.dir, '..', 'playground');

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
    }),
  );
  return files.flat();
}

test('SDK playgrounds never default to or recommend retired managed GLM 5.2', async () => {
  const offenders: string[] = [];
  for (const path of await sourceFiles(playgroundRoot)) {
    if ((await Bun.file(path).text()).includes('glm-5.2')) {
      offenders.push(path.slice(playgroundRoot.length + 1));
    }
  }
  expect(offenders).toEqual([]);
});
