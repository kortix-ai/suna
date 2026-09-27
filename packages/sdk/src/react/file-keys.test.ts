import { describe, expect, test } from 'bun:test';

/**
 * The live event stream invalidates the host's workspace file caches through
 * these factories. They only work when the host builds its query keys with
 * the SAME factories. Before this test, `apps/web` hand-copied them under a
 * different prefix (`runtime-files` vs the SDK's `opencode-files`), so every
 * `file.edited` and turn-end invalidation matched nothing, and an open file
 * viewer kept showing the version from before the agent's edit.
 */
describe('file key factories', () => {
  test('are exported from @kortix/sdk/react, so a host can build its keys from them', async () => {
    const react = await import('./index');
    expect(react.fileContentKeys).toBeDefined();
    expect(react.fileListKeys).toBeDefined();
    expect(react.gitStatusKeys).toBeDefined();
    expect(react.binaryBlobKeys).toBeDefined();
  });

  test('every per-file key starts with its family prefix, so invalidating `.all` reaches it', async () => {
    const { fileContentKeys, fileListKeys, gitStatusKeys, binaryBlobKeys } = await import(
      './file-keys'
    );
    const url = 'http://sandbox.test';
    expect(fileContentKeys.file(url, '/a.md').slice(0, 2)).toEqual([...fileContentKeys.all]);
    expect(binaryBlobKeys.file(url, '/a.pdf').slice(0, 2)).toEqual([...binaryBlobKeys.all]);
    expect(fileListKeys.dir(url, '/').slice(0, 2)).toEqual([...fileListKeys.all]);
    expect(gitStatusKeys.status(url).slice(0, 2)).toEqual([...gitStatusKeys.all]);
  });

  test('all four families share one root, so one prefix drops every workspace file cache', async () => {
    const { fileContentKeys, fileListKeys, gitStatusKeys, binaryBlobKeys } = await import(
      './file-keys'
    );
    const roots = new Set(
      [fileContentKeys, fileListKeys, gitStatusKeys, binaryBlobKeys].map((k) => k.all[0]),
    );
    expect([...roots]).toEqual(['runtime-files']);
  });
});
