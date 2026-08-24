import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

const configState: Record<string, unknown> = {
  KORTIX_URL: 'https://dev-api.kortix.com',
  INTERNAL_KORTIX_ENV: 'dev',
  PORT: 8008,
  KORTIX_PREVIEW_BASE_DOMAIN: undefined,
};
mock.module('../config', () => ({ config: configState }));

const {
  previewBaseDomain,
  previewOriginFor,
  previewUrlTemplate,
  resolvePreviewHost,
  sandboxHostLabel,
  warnIfPreviewOriginsMissing,
} = await import('./preview-hosts');

const SBX = 'sbx_01M0G4HXCM32BX5R1GPYZDYC1H';
const LABEL = 'sbx-01m0g4hxcm32bx5r1gpyzdyc1h';

const savedEnv = { ...process.env };
beforeEach(() => {
  configState.KORTIX_PREVIEW_BASE_DOMAIN = undefined;
  delete process.env.KORTIX_PREVIEW_LOCAL;
  delete process.env.KORTIX_PREVIEW_LOCAL_PORT;
  configState.KORTIX_URL = 'https://dev-api.kortix.com';
  configState.INTERNAL_KORTIX_ENV = 'dev';
  configState.PORT = 8008;
});
afterEach(() => {
  process.env = { ...savedEnv };
});

describe('sandboxHostLabel', () => {
  test('lowercases and replaces the underscore DNS cannot carry', () => {
    expect(sandboxHostLabel(SBX)).toBe(LABEL);
  });
  test('leaves an already-safe id alone', () => {
    expect(sandboxHostLabel('sb-abc123')).toBe('sb-abc123');
  });
  test('produces a label within the 63-character DNS limit', () => {
    expect(sandboxHostLabel(SBX).length).toBeLessThan(50);
  });
});

describe('previewBaseDomain', () => {
  test('is null unless the deployment declares one', () => {
    expect(previewBaseDomain()).toBeNull();
  });

  test('never derives a domain from the API origin', () => {
    // A worktree's KORTIX_URL is a cloudflared tunnel. Deriving
    // `p.trycloudflare.com` from it published a hostname nobody serves and
    // every preview URL it produced was dead.
    configState.KORTIX_URL = 'https://random-words-here.trycloudflare.com';
    expect(previewBaseDomain()).toBeNull();
    expect(previewUrlTemplate()).toBeNull();
  });

  test('takes the declared domain and normalizes it', () => {
    configState.KORTIX_PREVIEW_BASE_DOMAIN = 'https://Preview.ACME.io/';
    expect(previewBaseDomain()).toBe('preview.acme.io');
  });

  test('treats a blank declaration as none', () => {
    configState.KORTIX_PREVIEW_BASE_DOMAIN = '   ';
    expect(previewBaseDomain()).toBeNull();
  });
});

describe('previewUrlTemplate', () => {
  test('carries the shape to the client with only two slots', () => {
    configState.KORTIX_PREVIEW_BASE_DOMAIN = 'p.kortix.com';
    expect(previewUrlTemplate()).toBe('https://dev-p{port}-{sandbox}.p.kortix.com');
  });

  test('each environment gets its own label under one wildcard', () => {
    configState.KORTIX_PREVIEW_BASE_DOMAIN = 'p.kortix.com';
    configState.INTERNAL_KORTIX_ENV = 'prod';
    expect(previewUrlTemplate()).toBe('https://prod-p{port}-{sandbox}.p.kortix.com');
  });

  test('is null without a declared domain, which means the path proxy', () => {
    expect(previewUrlTemplate()).toBeNull();
  });
});

describe('resolvePreviewHost', () => {
  beforeEach(() => {
    configState.KORTIX_PREVIEW_BASE_DOMAIN = 'p.kortix.com';
  });

  test('round-trips the hostname the template describes', () => {
    expect(resolvePreviewHost(`dev-p8081-${LABEL}.p.kortix.com`)).toEqual({
      port: 8081,
      sandboxLabel: LABEL,
      local: false,
    });
  });

  test('matches the local form even with no domain declared', () => {
    configState.KORTIX_PREVIEW_BASE_DOMAIN = undefined;
    expect(resolvePreviewHost(`p3000-${LABEL}.localhost:8008`)).toEqual({
      port: 3000,
      sandboxLabel: LABEL,
      local: true,
    });
  });
  test('accepts a Host header carrying a port and a trailing dot', () => {
    expect(resolvePreviewHost(`dev-p8081-${LABEL}.p.kortix.com.:443`)).toEqual({
      port: 8081,
      sandboxLabel: LABEL,
      local: false,
    });
  });
  test('matches the local form', () => {
    expect(resolvePreviewHost(`p3000-${LABEL}.localhost:8008`)).toEqual({
      port: 3000,
      sandboxLabel: LABEL,
      local: true,
    });
  });
  test('refuses another environment’s label', () => {
    expect(resolvePreviewHost(`prod-p8081-${LABEL}.p.kortix.com`)).toBeNull();
  });
  test('refuses a nested label that would escape the wildcard certificate', () => {
    expect(resolvePreviewHost(`a.dev-p8081-${LABEL}.p.kortix.com`)).toBeNull();
  });
  test('refuses the API host itself and unrelated hosts', () => {
    expect(resolvePreviewHost('dev-api.kortix.com')).toBeNull();
    expect(resolvePreviewHost('evil.com')).toBeNull();
    expect(resolvePreviewHost('')).toBeNull();
  });
  test('refuses a malformed label', () => {
    expect(resolvePreviewHost('dev-p-abc.p.kortix.com')).toBeNull();
    expect(resolvePreviewHost('dev-8081-abc.p.kortix.com')).toBeNull();
    expect(resolvePreviewHost(`dev-p99999999-${LABEL}.p.kortix.com`)).toBeNull();
  });
});

describe('previewOriginFor', () => {
  test('builds the full origin a shared preview is served on', () => {
    configState.KORTIX_PREVIEW_BASE_DOMAIN = 'p.kortix.com';
    expect(previewOriginFor(SBX, 8081)).toBe(`https://dev-p8081-${LABEL}.p.kortix.com`);
  });

  test('is null without a declared domain, so a share keeps the path proxy', () => {
    expect(previewOriginFor(SBX, 8081)).toBeNull();
  });

  test('rejects a port outside the valid range', () => {
    configState.KORTIX_PREVIEW_BASE_DOMAIN = 'p.kortix.com';
    expect(previewOriginFor(SBX, 0)).toBeNull();
    expect(previewOriginFor(SBX, 70000)).toBeNull();
  });

  test('round-trips through the inbound matcher', () => {
    configState.KORTIX_PREVIEW_BASE_DOMAIN = 'p.kortix.com';
    const origin = previewOriginFor(SBX, 3000)!;
    expect(resolvePreviewHost(new URL(origin).hostname)).toEqual({
      port: 3000,
      sandboxLabel: LABEL,
      local: false,
    });
  });
});

describe('warnIfPreviewOriginsMissing', () => {
  /** Collects the warnings a boot would emit. */
  const spy = () => {
    const calls: Array<{ message: string; meta?: Record<string, unknown> }> = [];
    return {
      calls,
      warn: (message: string, meta?: Record<string, unknown>) => calls.push({ message, meta }),
    };
  };

  test('warns on a public deployment with no preview domain — the silent-downgrade case', () => {
    configState.KORTIX_URL = 'https://api.essentia.kortix.cloud';
    configState.KORTIX_PREVIEW_BASE_DOMAIN = undefined;
    const log = spy();
    warnIfPreviewOriginsMissing(log);
    expect(log.calls).toHaveLength(1);
    expect(log.calls[0]!.message).toContain('no KORTIX_PREVIEW_BASE_DOMAIN');
    expect(log.calls[0]!.meta?.kortix_url).toBe('https://api.essentia.kortix.cloud');
  });

  test('silent once a preview domain is configured', () => {
    configState.KORTIX_URL = 'https://api.essentia.kortix.cloud';
    configState.KORTIX_PREVIEW_BASE_DOMAIN = 'p.essentia.kortix.cloud';
    const log = spy();
    warnIfPreviewOriginsMissing(log);
    expect(log.calls).toEqual([]);
  });

  test.each([
    ['localhost', 'https://localhost:8008'],
    ['a *.localhost host', 'https://api.my-worktree.localhost:8008'],
    ['a quick cloudflared tunnel', 'https://random-words-here.trycloudflare.com'],
    ['plain http', 'http://api.example.com'],
    ['an unset KORTIX_URL', ''],
  ])('stays silent for %s — the path form is correct there', (_label, url) => {
    configState.KORTIX_URL = url;
    configState.KORTIX_PREVIEW_BASE_DOMAIN = undefined;
    const log = spy();
    warnIfPreviewOriginsMissing(log);
    expect(log.calls).toEqual([]);
  });

  test('never throws — a warning must never become an outage', () => {
    configState.KORTIX_URL = 'not a url';
    configState.KORTIX_PREVIEW_BASE_DOMAIN = undefined;
    const log = spy();
    expect(() => warnIfPreviewOriginsMissing(log)).not.toThrow();
    expect(log.calls).toEqual([]);
  });
});
