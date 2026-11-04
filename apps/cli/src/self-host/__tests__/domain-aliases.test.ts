import { describe, expect, test } from 'bun:test';

import { renderCaddyfile } from '../compose-assets.ts';
import {
  deriveDomainAliasHosts,
  normalizeHostname,
  parseDomainList,
  planDomainMove,
} from '../domain-aliases.ts';

const ENV = {
  KORTIX_DOMAIN: 'kortix.acme.com',
  KORTIX_API_DOMAIN: 'api.kortix.acme.com',
  KORTIX_APPS_BASE_DOMAIN: 'apps.kortix.acme.com',
  KORTIX_PREVIEW_BASE_DOMAIN: 'p.kortix.acme.com',
  KORTIX_ACME_EMAIL: 'admin@kortix.acme.com',
};

describe('domain names', () => {
  test('normalizes a pasted URL and rejects what is not a hostname', () => {
    expect(normalizeHostname(' HTTPS://Kortix.Acme.com:443/path ')).toBe('kortix.acme.com');
    expect(normalizeHostname('kortix.acme.com.')).toBe('kortix.acme.com');
    for (const bad of ['', 'localhost', 'a b.com', '*.acme.com', 'acme.com {', '-x.acme.com']) {
      expect(normalizeHostname(bad)).toBeNull();
    }
  });

  test('a list is deduplicated, and one bad entry fails the whole list', () => {
    expect(parseDomainList('old.acme.cloud, OLD.acme.cloud  older.acme.io')).toEqual(['old.acme.cloud', 'older.acme.io']);
    expect(() => parseDomainList('old.acme.cloud,acme.com {')).toThrow('"{" is not a valid domain name');
  });
});

describe('deriveDomainAliasHosts', () => {
  test('every host under the primary domain has the same prefix under each alias', () => {
    expect(deriveDomainAliasHosts({ ...ENV, KORTIX_DOMAIN_ALIASES: 'old.acme.cloud' })).toEqual({
      app: ['old.acme.cloud'],
      api: ['api.old.acme.cloud'],
      apps: ['apps.old.acme.cloud'],
      preview: ['p.old.acme.cloud'],
    });
  });

  test('a host outside the primary domain has no alias form; the primary itself is never an alias', () => {
    const hosts = deriveDomainAliasHosts({
      ...ENV,
      KORTIX_API_DOMAIN: 'api.elsewhere.net',
      KORTIX_PREVIEW_BASE_DOMAIN: '',
      KORTIX_DOMAIN_ALIASES: 'kortix.acme.com,old.acme.cloud',
    });
    expect(hosts).toEqual({ app: ['old.acme.cloud'], api: [], apps: ['apps.old.acme.cloud'], preview: [] });
  });

  test('no primary domain or no aliases: nothing', () => {
    expect(deriveDomainAliasHosts({ KORTIX_DOMAIN_ALIASES: 'old.acme.cloud' })).toEqual({ app: [], api: [], apps: [], preview: [] });
    expect(deriveDomainAliasHosts(ENV)).toEqual({ app: [], api: [], apps: [], preview: [] });
  });
});

describe('planDomainMove', () => {
  test('moves every derived host and keeps the old domain as the first alias', () => {
    const plan = planDomainMove({ ...ENV, KORTIX_DOMAIN_ALIASES: 'older.acme.io' }, 'Kortix.Acme-Corp.com');
    expect(plan).toEqual({
      from: 'kortix.acme.com',
      to: 'kortix.acme-corp.com',
      changes: {
        KORTIX_DOMAIN: 'kortix.acme-corp.com',
        KORTIX_API_DOMAIN: 'api.kortix.acme-corp.com',
        KORTIX_APPS_BASE_DOMAIN: 'apps.kortix.acme-corp.com',
        KORTIX_PREVIEW_BASE_DOMAIN: 'p.kortix.acme-corp.com',
        KORTIX_ACME_EMAIL: 'admin@kortix.acme-corp.com',
        KORTIX_DOMAIN_ALIASES: 'kortix.acme.com,older.acme.io',
      },
    });
  });

  test('moving back to a former domain removes it from the aliases', () => {
    const first = planDomainMove(ENV, 'new.acme.io');
    const back = planDomainMove({ ...ENV, ...first.changes }, 'kortix.acme.com');
    expect(back.changes.KORTIX_DOMAIN_ALIASES).toBe('new.acme.io');
    expect(back.changes.KORTIX_API_DOMAIN).toBe('api.kortix.acme.com');
  });

  test('keeps an operator-chosen API host or ACME contact outside the old domain', () => {
    const plan = planDomainMove(
      { ...ENV, KORTIX_API_DOMAIN: 'api.elsewhere.net', KORTIX_ACME_EMAIL: 'ops@acme.com' },
      'new.acme.io',
    );
    expect(plan.changes.KORTIX_API_DOMAIN).toBe('api.elsewhere.net');
    expect(plan.changes.KORTIX_ACME_EMAIL).toBeUndefined();
  });

  test('refuses an instance without a domain, a bad name, and a no-op', () => {
    expect(() => planDomainMove({}, 'new.acme.io')).toThrow('no domain');
    expect(() => planDomainMove(ENV, 'not a domain')).toThrow('not a valid domain name');
    expect(() => planDomainMove(ENV, 'kortix.acme.com')).toThrow('already the primary domain');
  });
});

describe('renderCaddyfile with domain aliases', () => {
  const aliases = deriveDomainAliasHosts({ ...ENV, KORTIX_DOMAIN_ALIASES: 'old.acme.cloud,older.acme.io' });
  const rendered = renderCaddyfile({ appsHostingConfigured: true, previewHostingConfigured: true, domainAliases: aliases });

  test('alias API hosts are served by the API site block itself', () => {
    expect(rendered).toContain('\n{$KORTIX_API_DOMAIN}, api.old.acme.cloud, api.older.acme.io {\n');
  });

  test('alias Apps and preview wildcards share their primary site block', () => {
    expect(rendered).toContain('*.{$KORTIX_APPS_BASE_DOMAIN}, *.apps.old.acme.cloud, *.apps.older.acme.io {');
    expect(rendered).toContain('*.{$KORTIX_PREVIEW_BASE_DOMAIN}, *.p.old.acme.cloud, *.p.older.acme.io {');
    expect(rendered.match(/on_demand_tls \{/g)).toHaveLength(1);
  });

  test('alias web-app hosts are served by the web-app site block itself', () => {
    expect(rendered).toContain('\n{$KORTIX_DOMAIN}, old.acme.cloud, older.acme.io {\n');
    expect(rendered).not.toContain('redir ');
  });

  test('a web-app-only alias set adds no on-demand TLS gate', () => {
    const appOnly = renderCaddyfile({ domainAliases: { app: ['old.acme.cloud'], api: [], apps: [], preview: [] } });
    expect(appOnly).not.toContain('on_demand_tls');
    expect(appOnly).toContain('\n{$KORTIX_DOMAIN}, old.acme.cloud {\n');
  });

  test('no aliases: byte-identical to the file rendered without the option', () => {
    const empty = { app: [], api: [], apps: [], preview: [] };
    expect(renderCaddyfile({ appsHostingConfigured: true, domainAliases: empty })).toBe(
      renderCaddyfile({ appsHostingConfigured: true }),
    );
    expect(renderCaddyfile({ domainAliases: empty })).toBe(renderCaddyfile());
  });
});
