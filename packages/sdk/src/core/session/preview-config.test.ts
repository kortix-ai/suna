import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

let responses: Array<{ success: boolean; data?: unknown }> = [];
let calls: string[] = [];

mock.module('../http/api-client', () => ({
  backendApi: {
    get: async (endpoint: string) => {
      calls.push(endpoint);
      const next = responses.shift();
      if (!next) throw new Error('network down');
      return next;
    },
  },
}));

const { cachedPreviewUrlTemplate, loadPreviewUrlTemplate, resetPreviewConfigCache } = await import(
  './preview-config'
);

const BACKEND = 'https://dev-api.kortix.com/v1';

beforeEach(() => {
  resetPreviewConfigCache();
  responses = [];
  calls = [];
});
afterEach(() => resetPreviewConfigCache());

describe('preview config', () => {
  it('is unknown until loaded, which means the path form', () => {
    expect(cachedPreviewUrlTemplate(BACKEND)).toBeNull();
  });

  it('caches the template the deployment advertises', async () => {
    responses = [{ success: true, data: { preview_url_template: 'https://dev-p{port}-{sandbox}.p.kortix.com' } }];
    expect(await loadPreviewUrlTemplate(BACKEND)).toBe('https://dev-p{port}-{sandbox}.p.kortix.com');
    expect(cachedPreviewUrlTemplate(BACKEND)).toBe('https://dev-p{port}-{sandbox}.p.kortix.com');
  });

  it('asks once, however many callers there are', async () => {
    responses = [{ success: true, data: { preview_url_template: 'https://dev-p{port}-{sandbox}.p.kortix.com' } }];
    const [a, b, c] = await Promise.all([
      loadPreviewUrlTemplate(BACKEND),
      loadPreviewUrlTemplate(BACKEND),
      loadPreviewUrlTemplate(BACKEND),
    ]);
    expect([a, b, c]).toEqual([a, a, a]);
    expect(calls).toEqual(['/p/config']);
  });

  it('ignores a trailing slash difference in the backend URL', async () => {
    responses = [{ success: true, data: { preview_url_template: 'https://dev-p{port}-{sandbox}.p.kortix.com' } }];
    await loadPreviewUrlTemplate(BACKEND);
    expect(cachedPreviewUrlTemplate(`${BACKEND}/`)).toBe('https://dev-p{port}-{sandbox}.p.kortix.com');
  });

  it('remembers a deployment that serves no preview domain', async () => {
    responses = [{ success: true, data: { preview_url_template: null } }];
    expect(await loadPreviewUrlTemplate(BACKEND)).toBeNull();
    // Cached as a real answer: no second request.
    expect(await loadPreviewUrlTemplate(BACKEND)).toBeNull();
    expect(calls).toEqual(['/p/config']);
  });

  it('does not remember a failed fetch — a blip is not an answer', async () => {
    expect(await loadPreviewUrlTemplate(BACKEND)).toBeNull();
    responses = [{ success: true, data: { preview_url_template: 'https://dev-p{port}-{sandbox}.p.kortix.com' } }];
    expect(await loadPreviewUrlTemplate(BACKEND)).toBe('https://dev-p{port}-{sandbox}.p.kortix.com');
  });

  it('does not remember an unsuccessful response either', async () => {
    responses = [{ success: false }];
    expect(await loadPreviewUrlTemplate(BACKEND)).toBeNull();
    responses = [{ success: true, data: { preview_url_template: 'https://prod-p{port}-{sandbox}.p.kortix.com' } }];
    expect(await loadPreviewUrlTemplate(BACKEND)).toBe('https://prod-p{port}-{sandbox}.p.kortix.com');
  });

  it('keeps deployments separate', async () => {
    responses = [
      { success: true, data: { preview_url_template: 'https://dev-p{port}-{sandbox}.p.kortix.com' } },
      { success: true, data: { preview_url_template: 'https://prod-p{port}-{sandbox}.p.kortix.com' } },
    ];
    await loadPreviewUrlTemplate(BACKEND);
    await loadPreviewUrlTemplate('https://api.kortix.com/v1');
    expect(cachedPreviewUrlTemplate(BACKEND)).toContain('dev-');
    expect(cachedPreviewUrlTemplate('https://api.kortix.com/v1')).toContain('prod-');
  });
});

describe('cache key normalization', () => {
  it('treats many trailing slashes as one deployment without pathological cost', async () => {
    responses = [{ success: true, data: { preview_url_template: 'https://dev-p{port}-{sandbox}.p.kortix.com' } }];
    await loadPreviewUrlTemplate(BACKEND);
    // A long run of '/' is the shape that makes a `/\/+$/` regex backtrack
    // quadratically (CodeQL js/polynomial-redos). The strip is linear, so this
    // resolves from cache immediately rather than hanging.
    const started = Date.now();
    expect(cachedPreviewUrlTemplate(`${BACKEND}${'/'.repeat(50_000)}`)).toBe(
      'https://dev-p{port}-{sandbox}.p.kortix.com',
    );
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(calls).toEqual(['/p/config']);
  });
});
