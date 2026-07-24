/**
 * Domain normalization — the pipeline's identity function.
 *
 * Every downstream key (job idempotency, profile cache row, memory file name)
 * is derived from the output here, so `Example.com`, `www.example.com/pricing`
 * and `https://WWW.Example.com.` must all collapse to exactly `example.com`.
 * Anything that cannot be reduced to a public, resolvable registrable hostname
 * is rejected as `invalid_domain` rather than guessed at.
 */
import { isIP } from 'node:net';
import { EnrichmentError } from '../errors';

const MAX_DOMAIN_LENGTH = 253;
const MAX_LABEL_LENGTH = 63;

// A label after URL parsing is already punycode-encoded, so IDN input arrives
// here as ASCII (`münchen.de` → `xn--mnchen-3ya.de`).
const LABEL_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
// The TLD must be alphabetic or a punycode `xn--` label. This is what rejects
// dotted-quad lookalikes such as `999.999.999.999`, which pass the label rules
// but are not hostnames.
const TLD_PATTERN = /^(xn--[a-z0-9-]+|[a-z]{2,})$/;

function reject(input: string, reason: string): never {
  throw new EnrichmentError('invalid_domain', `${reason}: ${input}`);
}

/**
 * Reduce arbitrary user input (bare domain or full URL) to a canonical apex
 * hostname. Throws {@link EnrichmentError} with code `invalid_domain` when the
 * input is not a public hostname.
 */
export function normalizeDomain(rawInput: string): string {
  if (typeof rawInput !== 'string') reject(String(rawInput), 'domain must be a string');
  const trimmed = rawInput.trim();
  if (!trimmed) reject(rawInput, 'domain is empty');
  if (trimmed.includes(' ')) reject(rawInput, 'domain must not contain whitespace');

  // Parse as a URL so hosts, ports, credentials, paths and IDN all normalize
  // through one well-tested implementation instead of ad-hoc string surgery.
  // A bare domain gets a scheme so `new URL` accepts it.
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    reject(rawInput, 'domain is not parseable');
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    reject(rawInput, 'only http and https are supported');
  }
  if (parsed.username || parsed.password) {
    reject(rawInput, 'domain must not contain credentials');
  }
  // Non-standard ports are refused rather than carried: the canonical origin is
  // always `https://<domain>`, so a port here could not survive normalization.
  if (parsed.port && parsed.port !== '443' && parsed.port !== '80') {
    reject(rawInput, 'non-standard ports are not supported');
  }

  let host = parsed.hostname.toLowerCase();
  // A fully-qualified name may carry a root dot; it is the same host.
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (host.startsWith('www.')) host = host.slice(4);

  if (!host) reject(rawInput, 'domain has no host');
  if (host.length > MAX_DOMAIN_LENGTH) reject(rawInput, 'domain is too long');
  // IP literals bypass the notion of a company website and are a classic SSRF
  // entry point; the egress guard would reject the private ones anyway, but
  // public literals are equally out of scope.
  if (isIP(host) !== 0 || (host.startsWith('[') && host.endsWith(']'))) {
    reject(rawInput, 'ip addresses are not supported');
  }

  const labels = host.split('.');
  if (labels.length < 2) reject(rawInput, 'domain must have a public suffix');
  for (const label of labels) {
    if (!label || label.length > MAX_LABEL_LENGTH || !LABEL_PATTERN.test(label)) {
      reject(rawInput, 'domain has an invalid label');
    }
  }
  if (!TLD_PATTERN.test(labels[labels.length - 1])) {
    reject(rawInput, 'domain has an invalid public suffix');
  }

  return host;
}

/** The single origin every crawl starts from. */
export function canonicalOrigin(domain: string): string {
  return `https://${domain}`;
}

/** Queue identity: one live job per project + domain pair. */
export function idempotencyKey(projectId: string, domain: string): string {
  return `${projectId}:${domain}`;
}
