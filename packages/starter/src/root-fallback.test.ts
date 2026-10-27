import { afterEach, describe, expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import embedded from './embedded.generated.json';

const fixtures: string[] = [];
afterEach(() => {
  for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function fixture() {
  const dir = mkdtempSync(join(import.meta.dir, '../.root-fallback-'));
  fixtures.push(dir);
  mkdirSync(join(dir, 'src'));
  copyFileSync(join(import.meta.dir, 'index.ts'), join(dir, 'src/index.ts'));
  copyFileSync(join(import.meta.dir, 'embedded.generated.json'), join(dir, 'src/embedded.generated.json'));
  const starter = await import(join(dir, 'src/index.ts'));
  return { dir, starter };
}

describe('template root fallback', () => {
  test('uses the embedded snapshot when the root is absent', async () => {
    const { starter } = await fixture();
    expect(starter.getManagedSkillFiles()).toEqual(
      [...embedded.managed.files].sort((a, b) => a.path.localeCompare(b.path)),
    );
  });

  test('serves the embedded project templates when their root is absent', async () => {
    const { starter } = await fixture();
    expect(starter.getProjectTemplateFiles()).toEqual(
      [...embedded['marketplace-projects'].files].sort((a, b) => a.path.localeCompare(b.path)),
    );
  });

  test('propagates a nested missing entry instead of using the snapshot', async () => {
    const { dir, starter } = await fixture();
    const root = join(dir, 'templates/managed');
    mkdirSync(join(root, 'nested'), { recursive: true });
    symlinkSync(join(dir, 'absent'), join(root, 'nested/broken'));
    expect(() => starter.getManagedSkillFiles()).toThrow('ENOENT');
  });

  test('propagates a root that is a file instead of using the snapshot', async () => {
    const { dir, starter } = await fixture();
    mkdirSync(join(dir, 'templates'));
    writeFileSync(join(dir, 'templates/managed'), 'not a directory');
    expect(() => starter.getManagedSkillFiles()).toThrow('ENOTDIR');
  });
});
