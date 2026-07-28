import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedRepoViaGitPush } from '../projects/git-backends/seed';

const originalPath = process.env.PATH;

afterEach(() => {
  process.env.PATH = originalPath;
});

describe('managed repository seed errors', () => {
  test('never expose the authorization header when git push has empty stderr', async () => {
    const binDir = await mkdtemp(join(tmpdir(), 'kortix-seed-git-'));
    const fakeGit = join(binDir, 'git');
    const realGit = Bun.which('git');
    if (!realGit) throw new Error('git is required for this test');

    await writeFile(
      fakeGit,
      `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "push" ]; then
    exit 1
  fi
done
exec "${realGit}" "$@"
`,
      'utf8',
    );
    await chmod(fakeGit, 0o755);
    process.env.PATH = `${binDir}:${originalPath ?? ''}`;

    const token = 'seed-secret-token-must-not-leak';
    const encoded = Buffer.from(`x-access-token:${token}`).toString('base64');

    try {
      await seedRepoViaGitPush({
        upstreamUrl: 'https://github.com/kortix-ai/redaction-test.git',
        token,
        files: [{ path: 'README.md', content: '# redaction test\n' }],
      });
      throw new Error('Expected seedRepoViaGitPush to reject');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain('git seed failed');
      expect(message).not.toContain(token);
      expect(message).not.toContain(encoded);
      expect(message.toLowerCase()).not.toContain('authorization');
      expect(message.toLowerCase()).not.toContain('extraheader');
    } finally {
      await rm(binDir, { recursive: true, force: true });
    }
  });
});
