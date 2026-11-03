import { beforeEach, describe, expect, mock, test } from 'bun:test';

const configState: Record<string, unknown> = {
  FRONTEND_URL: 'https://kortix.acme.cloud',
  KORTIX_URL: 'https://api.kortix.acme.cloud',
  KORTIX_DOMAIN_ALIASES: 'kortix.acme.com',
  KORTIX_PREVIEW_BASE_DOMAIN: 'p.kortix.acme.cloud',
  KORTIX_PREVIEW_BASE_DOMAIN_ALIASES: undefined,
  KORTIX_APPS_BASE_DOMAIN_ALIASES: undefined,
  INTERNAL_KORTIX_ENV: 'dev',
  PORT: 8008,
};
mock.module('../config', () => ({ config: configState }));

const { runWithContext, setContextField } = await import('../lib/request-context');
const {
  aliasCorsOrigins,
  aliasForHost,
  DOMAIN_ALIAS_CONTEXT_FIELD,
  domainAliases,
  forRequestApiUrl,
  forRequestDomain,
} = await import('./domain-aliases');
const { isAllowedPreviewOrigin, previewUrlTemplate, resolvePreviewHost } = await import('../sandbox-proxy/preview-hosts');

const LABEL = 'sbx-01aaaaaaaaaaaaaaaaaaaaaaaa';

/** Run `fn` the way the request-context middleware does for a request on `host`. */
function onHost<T>(host: string, fn: () => T): T {
  return runWithContext('GET', '/v1/p/config', () => {
    const alias = aliasForHost(host);
    if (alias) setContextField(DOMAIN_ALIAS_CONTEXT_FIELD, alias);
    return fn();
  });
}

beforeEach(() => {
  configState.FRONTEND_URL = 'https://kortix.acme.cloud';
  configState.KORTIX_DOMAIN_ALIASES = 'kortix.acme.com';
});

describe('alias domains', () => {
  test('aliases are normalized, deduplicated, and never include the primary domain', () => {
    configState.KORTIX_DOMAIN_ALIASES = ' HTTPS://Kortix.Acme.com/ , kortix.acme.cloud, kortix.acme.com';
    expect(domainAliases()).toEqual(['kortix.acme.com']);
  });

  test('a host belongs to an alias when it IS the alias or sits under it', () => {
    expect(aliasForHost('kortix.acme.com')).toBe('kortix.acme.com');
    expect(aliasForHost('api.kortix.acme.com:443')).toBe('kortix.acme.com');
    expect(aliasForHost('dev-p3000-x.p.kortix.acme.com')).toBe('kortix.acme.com');
    expect(aliasForHost('kortix.acme.cloud')).toBeNull();
    expect(aliasForHost('evilkortix.acme.com')).toBeNull();
  });

  test('a local frontend has no aliases at all', () => {
    configState.FRONTEND_URL = 'http://localhost:3000';
    expect(domainAliases()).toEqual([]);
    expect(aliasForHost('kortix.acme.com')).toBeNull();
  });
});

describe('URLs follow the domain a request arrived on', () => {
  test('a request on the alias API host gets alias preview URLs; the primary host gets primary ones', () => {
    expect(onHost('api.kortix.acme.com', () => previewUrlTemplate())).toBe(
      'https://dev-p{port}-{sandbox}.p.kortix.acme.com',
    );
    expect(onHost('api.kortix.acme.cloud', () => previewUrlTemplate())).toBe(
      'https://dev-p{port}-{sandbox}.p.kortix.acme.cloud',
    );
    // No request (a background job): the primary domain.
    expect(previewUrlTemplate()).toBe('https://dev-p{port}-{sandbox}.p.kortix.acme.cloud');
  });

  test('only hosts under the primary domain move; a foreign host is left alone', () => {
    expect(onHost('api.kortix.acme.com', () => forRequestDomain('apps.kortix.acme.cloud'))).toBe('apps.kortix.acme.com');
    expect(onHost('api.kortix.acme.com', () => forRequestDomain('apps.other.net'))).toBe('apps.other.net');
  });

  test('preview hosts under both domains resolve, from any request', () => {
    for (const base of ['p.kortix.acme.cloud', 'p.kortix.acme.com']) {
      expect(resolvePreviewHost(`dev-p3000-${LABEL}.${base}`)).toEqual({ port: 3000, sandboxLabel: LABEL, local: false });
    }
  });
});

describe('stored sandbox URLs follow the domain a request arrived on', () => {
  const stored = 'https://api.kortix.acme.cloud/v1/p/sbx-1/8000';

  test('a visitor on the alias gets the alias API host; the primary keeps its own', () => {
    expect(onHost('api.kortix.acme.com', () => forRequestApiUrl(stored))).toBe('https://api.kortix.acme.com/v1/p/sbx-1/8000');
    expect(onHost('api.kortix.acme.cloud', () => forRequestApiUrl(stored))).toBe(stored);
    expect(forRequestApiUrl(stored)).toBe(stored);
  });

  test('after a domain move, a row stored under the old primary (now an alias) moves to the new primary', () => {
    configState.FRONTEND_URL = 'https://kortix.acme.com';
    configState.KORTIX_URL = 'https://api.kortix.acme.com';
    configState.KORTIX_DOMAIN_ALIASES = 'kortix.acme.cloud';
    try {
      expect(onHost('api.kortix.acme.com', () => forRequestApiUrl(stored))).toBe('https://api.kortix.acme.com/v1/p/sbx-1/8000');
      expect(onHost('api.kortix.acme.cloud', () => forRequestApiUrl(stored))).toBe(stored);
    } finally {
      configState.KORTIX_URL = 'https://api.kortix.acme.cloud';
    }
  });

  test('a URL on a host this instance does not serve is left alone', () => {
    expect(onHost('api.kortix.acme.com', () => forRequestApiUrl('https://sandbox.example.net/x'))).toBe('https://sandbox.example.net/x');
    expect(forRequestApiUrl(null)).toBeNull();
  });
});

describe('browser origins', () => {
  test('alias web-app and API origins join the CORS allowlist', () => {
    expect(aliasCorsOrigins()).toEqual(['https://kortix.acme.com', 'https://api.kortix.acme.com']);
  });

  test('previews accept the alias web app as an embedding origin, nothing else', () => {
    expect(isAllowedPreviewOrigin('https://kortix.acme.cloud')).toBe(true);
    expect(isAllowedPreviewOrigin('https://kortix.acme.com')).toBe(true);
    expect(isAllowedPreviewOrigin('https://evil.example')).toBe(false);
  });
});
