import { describe, expect, test } from 'bun:test';
import { parse } from 'yaml';

import { renderCaddyfile, renderFullDockerCompose } from '../compose-assets.ts';
import {
  checkDelegation,
  delegationRecords,
  enabledWildcardBases,
  parseAcmeDnsAccount,
  renderAcmeDnsConfig,
  WILDCARD_CADDY_IMAGE,
  wildcardBases,
} from '../wildcard-tls.ts';

const ENV = {
  KORTIX_DOMAIN: 'kortix.acme.cloud',
  KORTIX_APPS_BASE_DOMAIN: 'apps.kortix.acme.cloud',
  KORTIX_PREVIEW_BASE_DOMAIN: 'p.kortix.acme.cloud',
  KORTIX_APPS_BASE_DOMAIN_ALIASES: 'apps.kortix.acme.com',
  KORTIX_PREVIEW_BASE_DOMAIN_ALIASES: 'p.kortix.acme.com',
};
const ALIASES = { app: ['kortix.acme.com'], api: ['api.kortix.acme.com'], apps: ['apps.kortix.acme.com'], preview: ['p.kortix.acme.com'] };

describe('wildcard bases', () => {
  test('the Apps and preview bases of the primary domain and every alias each get one wildcard certificate', () => {
    expect(wildcardBases(ENV)).toEqual(['apps.kortix.acme.cloud', 'p.kortix.acme.cloud', 'apps.kortix.acme.com', 'p.kortix.acme.com']);
  });

  test('a switched base the instance no longer serves is ignored', () => {
    expect(enabledWildcardBases({ ...ENV, KORTIX_WILDCARD_TLS_BASES: 'p.kortix.acme.com,p.gone.example' })).toEqual(['p.kortix.acme.com']);
  });
});

describe('acme-dns', () => {
  test('answers for the delegated zone only, with its NS and A records', () => {
    const config = renderAcmeDnsConfig({ zone: 'acme.kortix.acme.com', publicIp: '203.0.113.10', adminEmail: 'ops@acme.com' });
    expect(config).toContain('domain = "acme.kortix.acme.com"');
    expect(config).toContain('nsname = "ns.acme.kortix.acme.com"');
    expect(config).toContain('nsadmin = "ops.acme.com"');
    expect(config).toContain('"ns.acme.kortix.acme.com. A 203.0.113.10"');
    expect(config).toContain('"acme.kortix.acme.com. NS ns.acme.kortix.acme.com."');
  });

  test('refuses a zone or address that is not one', () => {
    expect(() => renderAcmeDnsConfig({ zone: 'not a zone', publicIp: '203.0.113.10' })).toThrow();
    expect(() => renderAcmeDnsConfig({ zone: 'acme.example.com', publicIp: '203.0.113' })).toThrow();
  });

  test('the operator adds the zone delegation once and one CNAME per base', () => {
    expect(
      delegationRecords({
        zone: 'acme.kortix.acme.com',
        publicIp: '203.0.113.10',
        accounts: { 'p.kortix.acme.com': { fulldomain: 'abc.acme.kortix.acme.com' } },
        bases: ['p.kortix.acme.com', 'apps.kortix.acme.com'],
      }),
    ).toEqual([
      { name: 'acme.kortix.acme.com', type: 'NS', value: 'ns.acme.kortix.acme.com' },
      { name: 'ns.acme.kortix.acme.com', type: 'A', value: '203.0.113.10' },
      { name: '_acme-challenge.p.kortix.acme.com', type: 'CNAME', value: 'abc.acme.kortix.acme.com' },
    ]);
  });
});

describe('acme-dns account record', () => {
  const zone = 'acme.kortix.acme.com';
  const registered = {
    username: 'eabcdb41-d89f-4580-826f-3e62e9755ef2',
    password: 'pbAXVjlIOE01xbut7YnAbkhMQIkcwoHO0ek2j4Q0',
    subdomain: 'd420c923-bbd7-4056-ab64-c3ca54c9b3cf',
    fulldomain: 'd420c923-bbd7-4056-ab64-c3ca54c9b3cf.acme.kortix.acme.com',
    allowfrom: [],
  };

  test('a registration answer becomes exactly the five fields Caddy reads, with the in-network server URL', () => {
    expect(parseAcmeDnsAccount({ ...registered, server_url: 'http://elsewhere.example' }, zone)).toEqual({
      username: registered.username,
      password: registered.password,
      subdomain: registered.subdomain,
      fulldomain: registered.fulldomain,
      server_url: 'http://acme-dns',
    });
  });

  test('anything that is not an account of this zone is refused', () => {
    expect(parseAcmeDnsAccount({ ...registered, fulldomain: 'd420c923-bbd7-4056-ab64-c3ca54c9b3cf.acme.other.com' }, zone)).toBeNull();
    expect(parseAcmeDnsAccount({ ...registered, subdomain: '../../etc' }, zone)).toBeNull();
    expect(parseAcmeDnsAccount({ ...registered, password: 'short' }, zone)).toBeNull();
    expect(parseAcmeDnsAccount({ ...registered, username: 'x\r\nX-Injected: 1' }, zone)).toBeNull();
    expect(parseAcmeDnsAccount(null, zone)).toBeNull();
    expect(parseAcmeDnsAccount('text', zone)).toBeNull();
  });
});

describe('Caddyfile with wildcard TLS', () => {
  const base = { appsHostingConfigured: true, previewHostingConfigured: true, domainAliases: ALIASES };

  test('no switched base: the file is byte for byte the one without wildcard TLS', () => {
    expect(renderCaddyfile({ ...base, wildcardTls: { bases: [] } })).toBe(renderCaddyfile(base));
  });

  test('a switched alias base gets its own DNS-01 block; the primary keeps on-demand TLS', () => {
    const rendered = renderCaddyfile({
      ...base,
      wildcardTls: { bases: ['apps.kortix.acme.com', 'p.kortix.acme.com'], appsBaseDomain: 'apps.kortix.acme.cloud', previewBaseDomain: 'p.kortix.acme.cloud' },
    });
    expect(rendered).toContain('*.{$KORTIX_APPS_BASE_DOMAIN} {');
    expect(rendered).toContain('*.{$KORTIX_PREVIEW_BASE_DOMAIN} {');
    expect(rendered).not.toContain('*.{$KORTIX_APPS_BASE_DOMAIN}, *.apps.kortix.acme.com');
    expect(rendered).toContain('*.apps.kortix.acme.com {');
    expect(rendered).toContain('dns acmedns /etc/caddy/acme-dns/apps.kortix.acme.com.json');
    expect(rendered).toContain('dns acmedns /etc/caddy/acme-dns/p.kortix.acme.com.json');
    expect(rendered).toContain('on_demand_tls {');
  });

  test('every base switched: no on-demand TLS is left at all', () => {
    const rendered = renderCaddyfile({
      ...base,
      wildcardTls: {
        bases: ['apps.kortix.acme.cloud', 'p.kortix.acme.cloud', 'apps.kortix.acme.com', 'p.kortix.acme.com'],
        appsBaseDomain: 'apps.kortix.acme.cloud',
        previewBaseDomain: 'p.kortix.acme.cloud',
      },
    });
    expect(rendered).not.toContain('on_demand');
    expect(rendered.match(/dns acmedns/g)?.length).toBe(4);
    expect(rendered).not.toContain('{$KORTIX_APPS_BASE_DOMAIN}');
  });

  test('the primary switched while an alias is not: the alias keeps on-demand TLS in its own block', () => {
    const rendered = renderCaddyfile({
      ...base,
      wildcardTls: { bases: ['apps.kortix.acme.cloud'], appsBaseDomain: 'apps.kortix.acme.cloud', previewBaseDomain: 'p.kortix.acme.cloud' },
    });
    expect(rendered).toContain('*.apps.kortix.acme.cloud {');
    expect(rendered).toMatch(/\n\*\.apps\.kortix\.acme\.com \{\n[^]*?on_demand/);
    expect(rendered).not.toContain('*.{$KORTIX_APPS_BASE_DOMAIN}');
  });
});

describe('Compose with wildcard TLS', () => {
  type Doc = { services: Record<string, { image?: string; ports?: string[]; volumes?: string[] }>; volumes: Record<string, unknown> };

  test('off: stock Caddy, no acme-dns', () => {
    const doc = parse(renderFullDockerCompose('kortix-test', { domainConfigured: true })) as Doc;
    expect(doc.services.caddy?.image).toBe('caddy:2.10.2-alpine');
    expect(doc.services['acme-dns']).toBeUndefined();
  });

  test('on: Caddy with the acmedns module, acme-dns on the box address only, API on loopback', () => {
    const doc = parse(renderFullDockerCompose('kortix-test', { domainConfigured: true, wildcardTlsConfigured: true })) as Doc;
    expect(doc.services.caddy?.image).toBe(WILDCARD_CADDY_IMAGE);
    expect(doc.services.caddy?.volumes).toContain('./acme-dns/accounts:/etc/caddy/acme-dns:ro');
    expect(doc.services['acme-dns']?.ports).toEqual([
      '${KORTIX_ACME_DNS_LISTEN_IP}:53:53/udp',
      '${KORTIX_ACME_DNS_LISTEN_IP}:53:53/tcp',
      '127.0.0.1:13750:80',
    ]);
    expect(doc.volumes).toHaveProperty('kortix-acme-dns-data');
  });

  test('no domain: wildcard TLS adds nothing', () => {
    const doc = parse(renderFullDockerCompose('kortix-test', { wildcardTlsConfigured: true })) as Doc;
    expect(doc.services['acme-dns']).toBeUndefined();
  });
});

describe('delegation check', () => {
  const account = { fulldomain: 'abc.acme.kortix.acme.com' };
  const cname = async () => ['abc.acme.kortix.acme.com'];

  test('passes when the zone holds the CNAME and one public resolver reads the fresh TXT back', async () => {
    let calls = 0;
    const txt = async (_name: string, server: string) => {
      calls++;
      if (server === '1.1.1.1') throw Object.assign(new Error('cached miss'), { code: 'ENODATA' });
      return [['fresh']];
    };
    const result = await checkDelegation('p.kortix.acme.com', account, 'fresh', { cname, txt, resolvers: ['1.1.1.1', '8.8.8.8'] });
    expect(result.ok).toBe(true);
    expect(calls).toBe(4); // three tries at the first resolver, then the second one answers
  });

  test('fails without the CNAME, on a CNAME to another account, and on a TXT that never reads back', async () => {
    const missing = async () => {
      throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' });
    };
    expect((await checkDelegation('p.kortix.acme.com', account, 'fresh', { cname: missing, txt: async () => [['fresh']] })).ok).toBe(false);
    expect(
      (await checkDelegation('p.kortix.acme.com', account, 'fresh', { cname: async () => ['other.acme.kortix.acme.com'], txt: async () => [['fresh']] })).ok,
    ).toBe(false);
    const stale = await checkDelegation('p.kortix.acme.com', account, 'fresh', { cname, txt: async () => [['old']], resolvers: ['1.1.1.1'] });
    expect(stale.ok).toBe(false);
    expect(stale.detail).toContain('port 53');
  });
});
