/**
 * Wildcard certificates for the App and preview hosts of a self-host.
 *
 * Without this, Caddy gets one certificate per App or preview host on its first
 * request (on-demand TLS, ACME HTTP-01). Every one of those certificates lands
 * in the public Certificate Transparency logs, so the logs list every App and
 * every sandbox preview, and a preview label is random by design
 * (`dev-p3000-<sandbox>.p.<domain>`). Threat-intelligence feeds that read the
 * logs score a domain with a stream of random-looking subdomains like malware
 * infrastructure, and a security filter in a home router then blocks the whole
 * domain.
 *
 * With wildcard TLS, each wildcard base (`apps.<domain>`, `p.<domain>`, and
 * the same bases under each alias domain) has ONE `*.<base>` certificate, and
 * the logs show only that wildcard. A wildcard certificate needs the ACME
 * DNS-01 challenge. The operator usually cannot give this box an API token for
 * their DNS, so the box runs its own small DNS server (acme-dns) for one
 * delegated zone, and the operator adds a few DNS records once:
 *
 *   <zone>                       NS     ns.<zone>
 *   ns.<zone>                    A      <public IP of this box>
 *   _acme-challenge.<base>       CNAME  <account id>.<zone>     (one per base)
 *
 * Caddy (the kortix/caddy image, with the acmedns module) then writes each
 * challenge into acme-dns, and renewals need nobody. acme-dns answers only for
 * its zone: it is not a resolver.
 */
import { Resolver } from 'node:dns/promises';

import { normalizeHostname, parseDomainList } from './domain-aliases';

/** The Caddy image with the acmedns module (apps/cli/src/self-host/caddy/Dockerfile). */
export const WILDCARD_CADDY_IMAGE = 'kortix/caddy:2.10.2-acmedns-0.7.0';
/** acme-dns, pinned. */
export const ACME_DNS_IMAGE = 'joohoi/acme-dns:v2.0.2';
/** The acme-dns API inside the Compose network. Caddy calls it; nothing outside the box can. */
export const ACME_DNS_SERVER_URL = 'http://acme-dns';
/**
 * The same API published on the box's loopback for the CLI. A fixed address, so
 * the CLI SDK-boundary lint can allow exactly this origin
 * (apps/cli/scripts/sdk-boundary.mjs) and no other loopback port.
 */
export const ACME_DNS_LOOPBACK_URL = 'http://127.0.0.1:13750';
/** Where the caddy container reads one credentials file per wildcard base. */
export const CADDY_ACME_DNS_DIR = '/etc/caddy/acme-dns';

/** The public resolvers the DNS check asks: two operators, so one cache cannot fake a pass. */
const PUBLIC_RESOLVERS = ['1.1.1.1', '8.8.8.8'];

type WildcardEnv = Partial<Record<string, string>>;

/** One acme-dns account: the shape `POST /register` returns, plus the server URL Caddy calls. */
export interface AcmeDnsAccount {
  username: string;
  password: string;
  subdomain: string;
  fulldomain: string;
  server_url: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** acme-dns makes a 40-character password from A–Z, a–z, 0–9, `-` and `_`; the range leaves room for a later version. */
const ACME_DNS_PASSWORD = /^[A-Za-z0-9_-]{32,128}$/;

/**
 * The one shape of an acme-dns account this CLI writes to disk or sends to
 * acme-dns. `value` is a `POST /register` response or a credentials file that
 * this CLI wrote earlier. The result is built only from fields that pass a strict
 * format check: `username` and `subdomain` are UUIDs, `password` is the
 * acme-dns alphabet, `fulldomain` is exactly `<subdomain>.<zone>`, and
 * `server_url` is always ACME_DNS_SERVER_URL, whatever `value` says. Any
 * other field (acme-dns also returns `allowfrom`) is dropped. Returns null when
 * `value` is not such an account, for example an account of another zone.
 *
 * Security review (CodeQL js/http-to-file-access and js/file-access-to-http):
 * the account goes from the box's own acme-dns, on loopback, to a 0600 file, and
 * back from that file to the same acme-dns. No other party is on either side.
 * This check makes sure no other data can travel the same way.
 */
export function parseAcmeDnsAccount(value: unknown, zone: string): AcmeDnsAccount | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const username = typeof raw.username === 'string' ? raw.username : '';
  const password = typeof raw.password === 'string' ? raw.password : '';
  const subdomain = typeof raw.subdomain === 'string' ? raw.subdomain : '';
  const fulldomain = typeof raw.fulldomain === 'string' ? raw.fulldomain.toLowerCase().replace(/\.$/, '') : '';
  const normalizedZone = normalizeHostname(zone);
  if (!UUID.test(username) || !UUID.test(subdomain) || !ACME_DNS_PASSWORD.test(password)) return null;
  if (!normalizedZone || fulldomain !== `${subdomain}.${normalizedZone}`) return null;
  return { username, password, subdomain, fulldomain, server_url: ACME_DNS_SERVER_URL };
}

export interface DnsRecord {
  name: string;
  type: 'NS' | 'A' | 'CNAME';
  value: string;
}

/**
 * Every wildcard base this instance serves: the Apps and preview bases of the
 * primary domain and of each alias domain. These are the names that get a
 * `*.<base>` certificate.
 */
export function wildcardBases(env: WildcardEnv): string[] {
  const out: string[] = [];
  const push = (raw: string | undefined) => {
    for (const base of parseDomainList(raw)) if (!out.includes(base)) out.push(base);
  };
  push(env.KORTIX_APPS_BASE_DOMAIN);
  push(env.KORTIX_PREVIEW_BASE_DOMAIN);
  push(env.KORTIX_APPS_BASE_DOMAIN_ALIASES);
  push(env.KORTIX_PREVIEW_BASE_DOMAIN_ALIASES);
  return out;
}

/** The bases switched to wildcard TLS (KORTIX_WILDCARD_TLS_BASES), limited to bases this instance still serves. */
export function enabledWildcardBases(env: WildcardEnv): string[] {
  const served = wildcardBases(env);
  return parseDomainList(env.KORTIX_WILDCARD_TLS_BASES).filter((base) => served.includes(base));
}

/** Whether wildcard TLS is set up at all: acme-dns runs and Caddy uses the image with the acmedns module. */
export function wildcardTlsConfigured(env: WildcardEnv): boolean {
  return Boolean(normalizeHostname(env.KORTIX_ACME_DNS_ZONE));
}

/** The acme-dns zone for an instance: an explicit KORTIX_ACME_DNS_ZONE, else `acme.<primary domain>`. */
export function defaultAcmeDnsZone(env: WildcardEnv): string | null {
  const domain = normalizeHostname(env.KORTIX_DOMAIN);
  return domain ? `acme.${domain}` : null;
}

/** The credentials file name of a base, inside the instance's acme-dns/accounts directory and CADDY_ACME_DNS_DIR. */
export function accountFileName(base: string): string {
  return `${base}.json`;
}

/**
 * acme-dns's config file. It answers DNS on port 53 for `zone` only, with the
 * zone's NS and A records and the TXT challenge values; its HTTP API listens
 * on port 80 inside the Compose network and is published on loopback only.
 */
export function renderAcmeDnsConfig(input: { zone: string; publicIp: string; adminEmail?: string }): string {
  const zone = normalizeHostname(input.zone);
  if (!zone) throw new Error(`"${input.zone}" is not a valid DNS zone`);
  if (!isIPv4(input.publicIp)) throw new Error(`"${input.publicIp}" is not an IPv4 address`);
  const admin = (input.adminEmail?.trim() || `hostmaster@${zone}`).replace('@', '.');
  return `# Rendered by kortix self-host (wildcard-tls.ts). Do not edit: \`kortix self-host tls wildcard\` rewrites it.
[general]
listen = "0.0.0.0:53"
protocol = "both4"
domain = "${zone}"
nsname = "ns.${zone}"
nsadmin = "${admin}"
records = [
    "${zone}. A ${input.publicIp}",
    "ns.${zone}. A ${input.publicIp}",
    "${zone}. NS ns.${zone}.",
]
debug = false

[database]
engine = "sqlite"
connection = "/var/lib/acme-dns/acme-dns.db"

[api]
ip = "0.0.0.0"
disable_registration = false
port = "80"
tls = "none"
corsorigins = []
use_header = false
header_name = "X-Forwarded-For"

[logconfig]
loglevel = "info"
logtype = "stdout"
logformat = "json"
`;
}

/** The DNS records the operator adds once, in their own DNS, for `bases` to get wildcard certificates. */
export function delegationRecords(input: {
  zone: string;
  publicIp: string;
  accounts: Readonly<Record<string, Pick<AcmeDnsAccount, 'fulldomain'>>>;
  bases: readonly string[];
}): DnsRecord[] {
  const records: DnsRecord[] = [
    { name: input.zone, type: 'NS', value: `ns.${input.zone}` },
    { name: `ns.${input.zone}`, type: 'A', value: input.publicIp },
  ];
  for (const base of input.bases) {
    const account = input.accounts[base];
    if (account) records.push({ name: `_acme-challenge.${base}`, type: 'CNAME', value: account.fulldomain });
  }
  return records;
}

export interface DelegationCheck {
  base: string;
  ok: boolean;
  /** What the DNS answered, for the operator. */
  detail: string;
}

type CnameLookup = (name: string) => Promise<string[]>;
type TxtLookup = (name: string, server: string) => Promise<string[][]>;

function resolverFor(server: string): Resolver {
  const resolver = new Resolver({ timeout: 4000, tries: 2 });
  resolver.setServers([server]);
  return resolver;
}

/**
 * The CNAME of `name` as its zone's authoritative nameserver answers it. A
 * public resolver may still cache "no such name" from an earlier run of
 * `tls wildcard`, made before the operator added the record; the authoritative
 * server caches nothing. The zone is the closest parent with NS records.
 */
export async function authoritativeCname(name: string, publicResolver = PUBLIC_RESOLVERS[0]!): Promise<string[]> {
  const labels = name.split('.');
  for (let i = 1; i < labels.length - 1; i++) {
    const zone = labels.slice(i).join('.');
    let servers: string[];
    try {
      servers = await resolverFor(publicResolver).resolveNs(zone);
    } catch {
      continue;
    }
    for (const server of servers) {
      let address: string | undefined;
      try {
        address = (await resolverFor(publicResolver).resolve4(server))[0];
      } catch {
        continue;
      }
      if (!address) continue;
      return (await resolverFor(address).resolveCname(name)).map((c) => c.replace(/\.$/, '').toLowerCase());
    }
  }
  throw Object.assign(new Error(`no nameserver found for ${name}`), { code: 'ENOTFOUND' });
}

/**
 * Whether the public DNS routes `base`'s ACME challenge to this box's acme-dns:
 * the zone's own nameserver holds the CNAME, and a TXT value written into
 * acme-dns right before the check reads back through a public resolver. The
 * read-back proves the NS delegation and that port 53 of this box answers the
 * internet. One resolver is enough; each gets three tries, since the first
 * answer of a fresh name can be a cached miss.
 */
export async function checkDelegation(
  base: string,
  account: Pick<AcmeDnsAccount, 'fulldomain'>,
  expectedTxt: string,
  lookups: { cname?: CnameLookup; txt?: TxtLookup; resolvers?: readonly string[] } = {},
): Promise<DelegationCheck> {
  const cnameOf = lookups.cname ?? ((name: string) => authoritativeCname(name));
  const txtOf = lookups.txt ?? ((name: string, server: string) => resolverFor(server).resolveTxt(name));
  const resolvers = lookups.resolvers ?? PUBLIC_RESOLVERS;
  const challenge = `_acme-challenge.${base}`;
  let target: string[];
  try {
    target = await cnameOf(challenge);
  } catch (error) {
    return { base, ok: false, detail: `${challenge}: no CNAME record (${dnsError(error)})` };
  }
  if (!target.includes(account.fulldomain.toLowerCase())) {
    return { base, ok: false, detail: `${challenge} points to ${target.join(', ')}, expected ${account.fulldomain}` };
  }
  let lastProblem = '';
  for (const server of resolvers) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const txt = await txtOf(account.fulldomain, server);
        if (txt.some((parts) => parts.join('') === expectedTxt)) {
          return { base, ok: true, detail: `delegated (${server} read the challenge back)` };
        }
        lastProblem = `${server} answers an older TXT value`;
      } catch (error) {
        lastProblem = `${server}: ${dnsError(error)}`;
      }
    }
  }
  return {
    base,
    ok: false,
    detail: `${account.fulldomain}: the challenge does not read back (${lastProblem}); check the NS and A records and that UDP and TCP port 53 reach this box`,
  };
}

function dnsError(error: unknown): string {
  return (error as { code?: string })?.code ?? (error instanceof Error ? error.message : String(error));
}

export function isIPv4(value: string | undefined): boolean {
  const parts = (value ?? '').trim().split('.');
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}
