/**
 * Connector egress — the one network path for connector traffic.
 *
 * Every connector request the API makes on a caller's behalf goes through
 * here: gateway calls (`/call`) for http, openapi, graphql, mcp, postman and
 * channel connectors, and the catalog reads that sync performs. The URL comes
 * from connector configuration a project member controls (`base_url`, an
 * OpenAPI `servers[0].url`, a Postman request URL, an MCP URL), so it is
 * resolved and checked on every request, including each redirect hop:
 *
 *   - the host must resolve to public addresses only (`safeEgressFetch`),
 *     unless an operator listed it in `KORTIX_CONNECTOR_EGRESS_ALLOW_HOSTS`;
 *   - redirects are followed manually and re-checked, a cross-origin hop drops
 *     `Authorization`;
 *   - http and https are both allowed. Existing connectors use plain http
 *     endpoints, and the address check is what keeps traffic off internal
 *     networks.
 *
 * `assertConnectorEndpointUrl` is the cheap, DNS-free twin used when a
 * connector is created or synced, so a misconfigured endpoint fails with a
 * clear message at configuration time instead of at the first call.
 */
import { config } from '../config';
import { isPrivateIp, safeEgressFetch, UnsafeEgressError } from '../shared/ssrf-guard';
import { isIP } from 'node:net';
import type { FetchImpl } from './call';

/** Stable prefix of the error a refused connector request carries. */
export const CONNECTOR_EGRESS_BLOCKED = 'connector_egress_blocked';

export interface ConnectorEgressOptions {
  /** Hosts allowed to resolve to a private address. Read per request. */
  allowPrivateHosts?: () => readonly string[];
}

const configuredAllowHosts = (): readonly string[] => config.KORTIX_CONNECTOR_EGRESS_ALLOW_HOSTS;

/** Build a {@link FetchImpl} that applies the connector egress rules. */
export function createConnectorEgressFetch(options: ConnectorEgressOptions = {}): FetchImpl {
  const allowPrivateHosts = options.allowPrivateHosts ?? configuredAllowHosts;
  return async (url, init) => {
    let res: Response;
    try {
      res = await safeEgressFetch(url, {
        method: init.method,
        headers: init.headers,
        body: init.body,
        allowHttp: true,
        allowPrivateHosts: allowPrivateHosts(),
        // Bun-only mTLS client certificate for `auth.type: mtls` connectors.
        ...(init.tls ? { tls: init.tls } : {}),
      } as Parameters<typeof safeEgressFetch>[1]);
    } catch (error) {
      if (error instanceof UnsafeEgressError) {
        // Never echo the full URL: query-string credentials live there.
        throw new Error(`${CONNECTOR_EGRESS_BLOCKED}: ${egressReason(error)}`);
      }
      throw error;
    }
    // `headers` carries `Mcp-Session-Id` back to the MCP session handshake in
    // call.ts. Without it every MCP call to a stateful server re-initializes.
    return { status: res.status, ok: res.ok, text: () => res.text(), headers: res.headers };
  };
}

/** The connector gateway's fetch. */
export const connectorEgressFetch: FetchImpl = createConnectorEgressFetch();

function egressReason(error: UnsafeEgressError): string {
  const message = error.message;
  if (message.startsWith('blocked') || message.startsWith('too many redirects')) {
    return `${message}. Connector endpoints must resolve to a public address.`;
  }
  return message;
}

/**
 * Throw when a connector endpoint is not an absolute http(s) URL on a public
 * host. DNS-free: it checks the literal host only. `safeEgressFetch` repeats
 * the check with DNS resolution on every request.
 */
export function assertConnectorEndpointUrl(
  address: string,
  options: { what?: string; allowPrivateHosts?: readonly string[] } = {},
): void {
  const what = options.what ?? 'Connector endpoint';
  let parsed: URL;
  try {
    parsed = new URL(address.trim());
  } catch {
    throw new ConnectorEndpointError(`${what} must be an absolute http(s) URL`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new ConnectorEndpointError(`${what} must use http or https`);
  }
  if (parsed.username || parsed.password) {
    throw new ConnectorEndpointError(`${what} must not embed credentials`);
  }
  const allow = (options.allowPrivateHosts ?? configuredAllowHosts()).map((h) => h.toLowerCase());
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (allow.includes(host)) return;
  if (isPrivateHostLiteral(host)) {
    throw new ConnectorEndpointError(`${what} must be a public host, not ${host}`);
  }
}

export class ConnectorEndpointError extends Error {
  readonly code = 'invalid_connector_endpoint';
  constructor(message: string) {
    super(message);
    this.name = 'ConnectorEndpointError';
  }
}

function isPrivateHostLiteral(host: string): boolean {
  if (!host || host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.internal') || host.endsWith('.local')) return true;
  const literal = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  return isIP(literal) !== 0 && isPrivateIp(literal);
}
