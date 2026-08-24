import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { stageOpencodeConfigTree } from './opencode-config-stage';

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

test('stageOpencodeConfigTree excludes developer-local dependency trees', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kortix-opencode-stage-test-'));
  const source = join(root, 'source');
  const destination = join(root, 'destination');

  try {
    await mkdir(join(source, 'tools'), { recursive: true });
    await mkdir(join(source, 'node_modules', 'provider-sdk'), { recursive: true });
    await mkdir(join(source, 'tools', 'node_modules', 'nested-sdk'), { recursive: true });
    await writeFile(join(source, 'package.json'), '{"dependencies":{"zod":"4.1.8"}}');
    await writeFile(join(source, 'tools', 'memory.ts'), 'export default {}');
    await writeFile(join(source, 'node_modules', 'provider-sdk', 'index.js'), 'heavy');
    await writeFile(join(source, 'tools', 'node_modules', 'nested-sdk', 'index.js'), 'heavy');

    await stageOpencodeConfigTree(source, destination);

    expect(await readFile(join(destination, 'package.json'), 'utf8')).toContain('zod');
    expect(await readFile(join(destination, 'tools', 'memory.ts'), 'utf8')).toBe(
      'export default {}',
    );
    expect(await exists(join(destination, 'node_modules'))).toBe(false);
    expect(await exists(join(destination, 'tools', 'node_modules'))).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
