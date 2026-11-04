import { beforeEach, expect, mock, test } from 'bun:test';
import { configureKortix } from '../../http/config';
import { createSandboxTemplate, updateSandboxTemplate, type SandboxTemplate } from './sandbox';

let calls: { url: string; method: string; body: unknown }[] = [];

beforeEach(() => {
  calls = [];
  globalThis.fetch = mock(async (url: unknown, opts: { method?: string; body?: string } = {}) => {
    calls.push({ url: String(url), method: opts.method ?? 'GET', body: opts.body ? JSON.parse(opts.body) : undefined });
    return new Response(JSON.stringify({ template_id: 't1', slug: 'web' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
});

configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
const last = () => calls[calls.length - 1];

test('createSandboxTemplate sends residential_proxy (true or a country) with the template', async () => {
  await createSandboxTemplate('P1', { slug: 'web', image: 'ubuntu:24.04', residential_proxy: { country: 'us' } });
  expect(last().url).toBe('http://test.local/projects/P1/sandbox-templates');
  expect(last().method).toBe('POST');
  expect(last().body).toEqual({ slug: 'web', image: 'ubuntu:24.04', residential_proxy: { country: 'us' } });

  await createSandboxTemplate('P1', { slug: 'web', image: 'ubuntu:24.04', residential_proxy: true });
  expect(last().body).toEqual({ slug: 'web', image: 'ubuntu:24.04', residential_proxy: true });
});

test('updateSandboxTemplate turns residential_proxy off with null', async () => {
  await updateSandboxTemplate('P1', 't1', { residential_proxy: null });
  expect(last().url).toBe('http://test.local/projects/P1/sandbox-templates/t1');
  expect(last().method).toBe('PATCH');
  expect(last().body).toEqual({ residential_proxy: null });
});

test('a listed template carries residential_proxy: null when off, the setting when on', () => {
  const off: Pick<SandboxTemplate, 'residential_proxy'> = { residential_proxy: null };
  const on: Pick<SandboxTemplate, 'residential_proxy'> = { residential_proxy: { country: 'de' } };
  expect([off.residential_proxy, on.residential_proxy]).toEqual([null, { country: 'de' }]);
});
