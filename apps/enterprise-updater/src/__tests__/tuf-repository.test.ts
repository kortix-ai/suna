import { afterEach, describe, expect, test } from 'bun:test';

import { downloadPinnedRoot, sha256Hex, stableTargetPath } from '../tuf-repository.ts';

let server: ReturnType<typeof Bun.serve> | undefined;

afterEach(() => {
  server?.stop(true);
  server = undefined;
});

describe('TUF bootstrap', () => {
  test('accepts only the exact offline-reviewed root bytes', async () => {
    const root = Buffer.from('{"signed":{"_type":"root"}}\n');
    server = Bun.serve({ port: 0, fetch: () => new Response(root) });
    const url = new URL('/metadata/1.root.json', server.url);
    expect(await downloadPinnedRoot(url, sha256Hex(root))).toEqual(root);
  });

  test('rejects changed root bytes before constructing a TUF client', async () => {
    const root = Buffer.from('{"signed":{"_type":"root"}}\n');
    server = Bun.serve({ port: 0, fetch: () => new Response(root) });
    const url = new URL('/metadata/1.root.json', server.url);
    await expect(downloadPinnedRoot(url, '0'.repeat(64))).rejects.toThrow('digest mismatch');
  });

  test('uses immutable release targets for explicit updates and rollbacks', () => {
    expect(stableTargetPath()).toBe('channels/stable.json');
    expect(stableTargetPath('0.9.84-e1')).toBe('releases/0.9.84-e1.json');
    expect(stableTargetPath(undefined, '0.9.83-e2')).toBe('releases/0.9.83-e2.json');
  });
});
