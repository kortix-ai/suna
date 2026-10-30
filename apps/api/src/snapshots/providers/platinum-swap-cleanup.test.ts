import { afterEach, expect, mock, test } from 'bun:test';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as staging from '../build-context';

let stagedPath = '';
mock.module('../build-context', () => ({
  ...staging,
  stageAgentBinaryGz: async () => {
    const dir = await mkdtemp(join(tmpdir(), 'platinum-swap-test-'));
    stagedPath = join(dir, 'kortix-agent.gz');
    await writeFile(stagedPath, 'synthetic-agent');
    return { gzPath: stagedPath, cleanup: () => rm(dir, { recursive: true, force: true }) };
  },
}));
const { PlatinumAdapter } = await import('./platinum');
const originalFetch = globalThis.fetch;
afterEach(async () => {
  globalThis.fetch = originalFetch;
  if (stagedPath) await rm(dirname(stagedPath), { recursive: true, force: true });
});

test.each([false, true])('swap removes its staged binary after patch failure=%s', async (fail) => {
  const failure = new Error('patch rejected');
  const calls: string[] = [];
  globalThis.fetch = Object.assign(async () => new Response('', { status: 200 }), { preconnect: originalFetch.preconnect });
  const adapter = new PlatinumAdapter({
    isConfigured: () => true,
    async json<T>(path: string): Promise<T> {
      calls.push(path);
      if (path.endsWith('/presign')) return Response.json({ upload_url: 'https://upload.example.test', context_s3_key: 'synthetic' }).json();
      if (path.endsWith('/from-patch')) {
        if (fail) throw failure;
        return Response.json({ id: 'tpl-synthetic' }).json();
      }
      return Response.json({ id: 'tpl-synthetic', name: 'new-template', state: 'ready' }).json();
    },
  });
  if (fail) await expect(adapter.swapAgent('new-template', 'old-template')).rejects.toBe(failure);
  else await expect(adapter.swapAgent('new-template', 'old-template')).resolves.toEqual({ externalTemplateId: 'tpl-synthetic' });
  expect(calls).toContain('/v1/templates/from-patch');
  await expect(access(stagedPath)).rejects.toThrow();
});
