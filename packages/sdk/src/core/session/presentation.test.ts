import { afterEach, beforeEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  buildPresentationMetadataUrl,
  buildPresentationTemplateImageUrl,
  buildPresentationTemplatePdfUrl,
  buildRuntimePresentationConversionUrl,
  fetchPresentationMetadata,
  sanitizePresentationName,
} from './presentation';
import type { SubdomainUrlOptions } from './url';

const DEPLOYED: SubdomainUrlOptions = {
  sandboxId: 'sb-abc123',
  backendPort: 8008,
  apiBaseUrl: 'https://api.example.test/v1',
};

const NO_RUNTIME: SubdomainUrlOptions = {
  sandboxId: '',
  backendPort: 8008,
  apiBaseUrl: 'https://api.example.test/v1',
};

test('presentation URL helpers own platform and runtime routes', () => {
  expect(buildPresentationTemplatePdfUrl('https://api.example.test/v1/', 'tpl 1')).toBe(
    'https://api.example.test/v1/presentation-templates/tpl%201/pdf#toolbar=0&navpanes=0&scrollbar=0&view=FitH',
  );
  expect(buildPresentationTemplateImageUrl('https://api.example.test/v1', 'tpl 1')).toBe(
    'https://api.example.test/v1/presentation-templates/tpl%201/image.png',
  );
  expect(buildRuntimePresentationConversionUrl('https://runtime.example.test/', 'pdf')).toBe(
    'https://runtime.example.test/presentation/convert-to-pdf',
  );
});

test('URL helpers do not use a backtracking trailing-slash expression', () => {
  const sources = [
    resolve(import.meta.dir, 'presentation.ts'),
    resolve(import.meta.dir, '../rest/platform-client/host-boundary.ts'),
    resolve(import.meta.dir, '../stream/fetch-sse.ts'),
  ].map((file) => readFileSync(file, 'utf8'));

  for (const source of sources) {
    expect(source).not.toContain("replace(/\\/+$/, '')");
  }
});

test('presentation names are sanitized the way the runtime names the directory', () => {
  expect(sanitizePresentationName('Q3 Board Review!')).toBe('q3boardreview');
  expect(sanitizePresentationName('launch-plan_v2')).toBe('launch-plan_v2');
});

test('metadata URL points at the static-file service with a cache-busting token', () => {
  expect(buildPresentationMetadataUrl('Q3 Board Review!', DEPLOYED, 1_700_000_000_000)).toBe(
    'https://api.example.test/v1/p/sb-abc123/3211/open?path=/workspace/presentations/q3boardreview/metadata.json&t=1700000000000',
  );
});

test('metadata URL is undefined without a presentation name or a runtime target', () => {
  expect(buildPresentationMetadataUrl('', DEPLOYED, 1)).toBeUndefined();
  expect(buildPresentationMetadataUrl('deck', NO_RUNTIME, 1)).toBeUndefined();
});

const originalFetch = globalThis.fetch;
const requests: Array<{ url: string; init?: RequestInit }> = [];
let responseFactory: () => Promise<Response>;

beforeEach(() => {
  requests.splice(0);
  responseFactory = async () => Response.json({ presentation_name: 'deck' });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    return responseFactory();
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('a written metadata.json resolves as ready', async () => {
  responseFactory = async () =>
    Response.json({
      presentation_name: 'q3boardreview',
      title: 'Q3',
      description: '',
      slides: {
        '1': {
          title: 'Intro',
          filename: 's1.html',
          file_path: '/workspace/s1.html',
          preview_url: '',
          created_at: '',
        },
      },
      created_at: '',
      updated_at: '',
    });

  const result = await fetchPresentationMetadata('Q3 Board Review!', DEPLOYED, {
    cacheBust: 1_700_000_000_000,
  });

  expect(result.status).toBe('ready');
  if (result.status !== 'ready') throw new Error('expected ready');
  expect(result.metadata.presentation_name).toBe('q3boardreview');
  expect(Object.keys(result.metadata.slides)).toEqual(['1']);
  expect(requests[0]?.url).toBe(
    'https://api.example.test/v1/p/sb-abc123/3211/open?path=/workspace/presentations/q3boardreview/metadata.json&t=1700000000000',
  );
  expect(requests[0]?.init?.cache).toBe('no-cache');
  expect(new Headers(requests[0]?.init?.headers).get('Cache-Control')).toBe('no-cache');
});

test('a not-yet-written metadata.json is a typed not-ready result, not a throw', async () => {
  responseFactory = async () => new Response('nope', { status: 404, statusText: 'Not Found' });

  const result = await fetchPresentationMetadata('deck', DEPLOYED, { cacheBust: 1 });

  expect(result).toEqual({
    status: 'not-ready',
    httpStatus: 404,
    reason: 'HTTP 404: Not Found',
  });
});

test('an unreachable runtime is a typed not-ready result, not a throw', async () => {
  responseFactory = async () => {
    throw new TypeError('Failed to fetch');
  };

  const result = await fetchPresentationMetadata('deck', DEPLOYED, { cacheBust: 1 });

  expect(result).toEqual({ status: 'not-ready', httpStatus: null, reason: 'Failed to fetch' });
});

test('unparseable metadata JSON is not-ready rather than a crash', async () => {
  responseFactory = async () =>
    new Response('<html>gateway</html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });

  const result = await fetchPresentationMetadata('deck', DEPLOYED, { cacheBust: 1 });

  expect(result.status).toBe('not-ready');
  if (result.status !== 'not-ready') throw new Error('expected not-ready');
  expect(result.httpStatus).toBe(200);
});

test('no runtime target yet is not-ready without any network call', async () => {
  const result = await fetchPresentationMetadata('deck', NO_RUNTIME, { cacheBust: 1 });

  expect(result).toEqual({
    status: 'not-ready',
    httpStatus: null,
    reason: 'No presentation metadata URL for this session runtime yet',
  });
  expect(requests).toHaveLength(0);
});

test('metadata fetch defaults the cache-busting token to the current time', async () => {
  const before = Date.now();
  await fetchPresentationMetadata('deck', DEPLOYED);
  const stamp = Number(new URL(requests[0]?.url ?? '').searchParams.get('t'));

  expect(Number.isFinite(stamp)).toBe(true);
  expect(stamp).toBeGreaterThanOrEqual(before);
});
