import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ensureAgentArtifactFresh } from '../snapshots/build-context';

const roots: string[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'kortix-agent-artifact-test-'));
  roots.push(root);
  const sourceDir = join(root, 'src');
  const binaryPath = join(root, 'dist', 'kortix-agent');
  await mkdir(sourceDir, { recursive: true });
  await mkdir(join(root, 'dist'), { recursive: true });
  await writeFile(join(sourceDir, 'main.ts'), 'export {}\n');
  return { sourceDir, binaryPath };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('snapshot agent artifact freshness', () => {
  test('builds a missing artifact and accepts the fresh result', async () => {
    const f = await fixture();
    let builds = 0;
    await ensureAgentArtifactFresh({
      ...f,
      build: async () => {
        builds += 1;
        await writeFile(f.binaryPath, 'linux-binary');
      },
    });
    expect(builds).toBe(1);
  });

  test('collapses concurrent stale-artifact repairs onto one build', async () => {
    const f = await fixture();
    await writeFile(f.binaryPath, 'old-binary');
    const old = new Date(Date.now() - 10_000);
    await utimes(f.binaryPath, old, old);
    let builds = 0;
    const build = async () => {
      builds += 1;
      await Bun.sleep(25);
      await writeFile(f.binaryPath, 'fresh-binary');
    };
    await Promise.all([
      ensureAgentArtifactFresh({ ...f, build }),
      ensureAgentArtifactFresh({ ...f, build }),
    ]);
    expect(builds).toBe(1);
  });

  test('refuses a build that leaves the artifact stale', async () => {
    const f = await fixture();
    await writeFile(f.binaryPath, 'still-old');
    const old = new Date(Date.now() - 10_000);
    await utimes(f.binaryPath, old, old);
    await expect(
      ensureAgentArtifactFresh({ ...f, build: async () => {} }),
    ).rejects.toThrow('still older');
  });
});
