import { isIP } from 'node:net';
import { config } from '../../config';
import { getConfigArchiveStore } from '../../config-releases/store';
import type { SandboxResidentialProxy } from '@kortix/shared/sandbox';
import { presignProjectSnapshotDownload } from '../../git-proxy/project-snapshot-store';
import { resolveLlmGatewayBaseUrl } from '../../llm-gateway/sandbox-base-url';
import {
  RESIDENTIAL_PROXY_NOT_OFFERED_MESSAGE,
  RESIDENTIAL_PROXY_PLATINUM_ONLY_MESSAGE,
} from './sandbox-provisioning-error';

/** The provider create option for a sandbox template's `residential_proxy`. */
export interface ResidentialProxyOption {
  /** Hostnames the box dials directly instead of through the residential IP. */
  bypass: string[];
  /** ISO 3166-1 alpha-2, lowercase: the country of the residential IP. */
  country?: string;
}

/**
 * Whether this deployment offers a residential IP: Platinum is the provider
 * and the operator turned on KORTIX_PLATINUM_RESIDENTIAL_PROXY after its
 * Platinum began serving `network.residential_proxy`.
 */
export function residentialProxyOffered(): boolean {
  return Boolean(config.PLATINUM_API_KEY) && config.KORTIX_PLATINUM_RESIDENTIAL_PROXY;
}

const PROBE_KEY = 'residential-proxy-bypass-probe';

/**
 * The provider create option for a session whose sandbox template asks for a
 * residential IP (`request`), or undefined when it does not. Fails closed: a
 * template that asks for one never boots on the sandbox's own address, so a
 * deployment that does not offer it, or a provider other than Platinum,
 * throws a `[residential-proxy]` configuration error and the session does not
 * start (sandbox-provisioning-error.ts).
 *
 * `bypass` lists the Kortix hosts the box itself calls: the API (KORTIX_URL,
 * the tunnel in local dev; also the git proxy and the secrets broker), the LLM
 * gateway, and the object stores the box downloads its boot files from
 * (config release, pi packages, project snapshots). Kortix traffic never
 * reaches the customer's bill, and a boot download never waits on a
 * residential line. Platinum bypasses the common package registries itself.
 * Signing a download URL is local, so the probe makes no request.
 */
export async function resolveSessionResidentialProxy(
  request: SandboxResidentialProxy | null | undefined,
  providerName: string,
): Promise<ResidentialProxyOption | undefined> {
  if (!request) return undefined;
  if (!residentialProxyOffered()) throw new Error(RESIDENTIAL_PROXY_NOT_OFFERED_MESSAGE);
  if (providerName !== 'platinum') throw new Error(RESIDENTIAL_PROXY_PLATINUM_ONLY_MESSAGE);
  const urls = await Promise.all(
    [
      config.KORTIX_URL,
      resolveLlmGatewayBaseUrl(config.KORTIX_URL),
      presignProjectSnapshotDownload(PROBE_KEY, 60).then((signed) => signed.url),
      // Signed for KORTIX_CONFIG_ARCHIVE_PUBLIC_URL when set: the host the box downloads from.
      getConfigArchiveStore().signedUrl(PROBE_KEY, 60),
    ].map((url) => Promise.resolve(url).catch(() => '')),
  );
  return {
    bypass: [...new Set(urls.map(bypassHost).filter((host): host is string => host !== null))],
    ...(request.country ? { country: request.country } : {}),
  };
}

/**
 * The hostname of `url` as Platinum accepts it in `bypass` (ASCII, punycode
 * for an IDN, no scheme or port), or null for an IP literal, localhost or a
 * value that is not a URL. A box never reaches those through the internet.
 */
export function bypassHost(url: string): string | null {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (!host || host === 'localhost' || host.endsWith('.localhost')) return null;
  if (isIP(host.replace(/^\[|\]$/g, ''))) return null;
  return host;
}
