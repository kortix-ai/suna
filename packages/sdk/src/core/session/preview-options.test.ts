import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

let template: string | null = null;
let answered = false;
let loads = 0;

mock.module('./preview-config', () => ({
  cachedPreviewUrlTemplate: () => template,
  hasPreviewConfig: () => answered,
  loadPreviewUrlTemplate: async () => {
    loads += 1;
    return template;
  },
}));

const { resolvePreviewOptions } = await import('./preview-options');

const INPUT = { sandboxId: 'sbx_A', apiBaseUrl: 'https://dev-api.kortix.com/v1', backendPort: 443 };

beforeEach(() => {
  template = null;
  answered = false;
  loads = 0;
});
afterEach(() => {
  template = null;
});

describe('resolvePreviewOptions', () => {
  it('always returns every field, so no caller can under-fill the bag', () => {
    expect(Object.keys(resolvePreviewOptions(INPUT)).sort()).toEqual([
      'apiBaseUrl',
      'backendPort',
      'previewUrlTemplate',
      'sandboxId',
    ]);
  });

  it('carries the deployment’s template through', () => {
    answered = true;
    template = 'https://dev-p{port}-{sandbox}.p.kortix.com';
    expect(resolvePreviewOptions(INPUT).previewUrlTemplate).toBe(
      'https://dev-p{port}-{sandbox}.p.kortix.com',
    );
  });

  it('asks again when this backend has never answered', () => {
    answered = false;
    resolvePreviewOptions(INPUT);
    expect(loads).toBe(1);
  });

  it('does not re-ask a deployment that answered "no preview domain"', () => {
    answered = true;
    template = null;
    resolvePreviewOptions(INPUT);
    expect(loads).toBe(0);
    expect(resolvePreviewOptions(INPUT).previewUrlTemplate).toBeNull();
  });

  it('passes the sandbox and backend through untouched', () => {
    const opts = resolvePreviewOptions(INPUT);
    expect(opts.sandboxId).toBe('sbx_A');
    expect(opts.apiBaseUrl).toBe('https://dev-api.kortix.com/v1');
    expect(opts.backendPort).toBe(443);
  });
});
