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
  /** What the public DNS answered, for the operator. */
  detail: string;
}

/**
 * Whether the public DNS routes `base`'s ACME challenge to this box's acme-dns:
 * the CNAME exists, and a TXT value written into acme-dns right before the
 * check reads back through two public resolvers. The read-back proves the NS
 * delegation and the port 53 path, not only that the records were typed in.
 */
export async function checkDelegation(
  base: string,
  account: Pick<AcmeDnsAccount, 'fulldomain'>,
  expectedTxt: string,
  resolvers: readonly string[] = PUBLIC_RESOLVERS,
): Promise<DelegationCheck> {
  for (const server of resolvers) {
    const resolver = new Resolver({ timeout: 4000, tries: 2 });
    resolver.setServers([server]);
    let cname: string[] = [];
    try {
      cname = await resolver.resolveCname(`_acme-challenge.${base}`);
    } catch (error) {
      return { base, ok: false, detail: `_acme-challenge.${base}: no CNAME at ${server} (${dnsError(error)})` };
    }
    const target = cname.map((c) => c.replace(/\.$/, '').toLowerCase());
    if (!target.includes(account.fulldomain.toLowerCase())) {
      return { base, ok: false, detail: `_acme-challenge.${base} points to ${target.join(', ')} at ${server}, expected ${account.fulldomain}` };
    }
    let txt: string[][] = [];
    try {
      txt = await resolver.resolveTxt(account.fulldomain);
    } catch (error) {
      return { base, ok: false, detail: `${account.fulldomain}: no TXT at ${server} (${dnsError(error)}); check the NS and A records and that UDP and TCP port 53 reach this box` };
    }
    if (!txt.some((parts) => parts.join('') === expectedTxt)) {
      return { base, ok: false, detail: `${account.fulldomain}: ${server} answers an old TXT value; the record may still be cached, run the check again in a minute` };
    }
  }
  return { base, ok: true, detail: `delegated (${resolvers.join(', ')} read the challenge back)` };
}

function dnsError(error: unknown): string {
  return (error as { code?: string })?.code ?? (error instanceof Error ? error.message : String(error));
}

export function isIPv4(value: string | undefined): boolean {
  const parts = (value ?? '').trim().split('.');
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}
