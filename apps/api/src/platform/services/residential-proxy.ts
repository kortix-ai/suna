import { isIP } from 'node:net';
import { config } from '../../config';
import { getConfigArchiveStore } from '../../config-releases/store';
import { resolveFeatureFlag } from '../../feature-flags/registry';
import { presignProjectSnapshotDownload } from '../../git-proxy/project-snapshot-store';
import { resolveLlmGatewayBaseUrl } from '../../llm-gateway/sandbox-base-url';

/** The provider create option for a project's `residential_proxy` flag. */
export interface ResidentialProxyOption {
  /** Hostnames the box dials directly instead of through the residential IP. */
  bypass: string[];
}

const PROBE_KEY = 'residential-proxy-bypass-probe';

/**
 * The project's `residential_proxy` flag as the provider create option, or
 * undefined when the flag is off. Only the Platinum provider reads it.
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
  projectMetadata: unknown,
): Promise<ResidentialProxyOption | undefined> {
  if (!resolveFeatureFlag(projectMetadata, 'residential_proxy')) return undefined;
  const urls = await Promise.all(
    [
      config.KORTIX_URL,
      resolveLlmGatewayBaseUrl(config.KORTIX_URL),
      presignProjectSnapshotDownload(PROBE_KEY, 60).then((signed) => signed.url),
      // Signed for KORTIX_CONFIG_ARCHIVE_PUBLIC_URL when set: the host the box downloads from.
      getConfigArchiveStore().signedUrl(PROBE_KEY, 60),
    ].map((url) => Promise.resolve(url).catch(() => '')),
  );
  return { bypass: [...new Set(urls.map(bypassHost).filter((host): host is string => host !== null))] };
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
