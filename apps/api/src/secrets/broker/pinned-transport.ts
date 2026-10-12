// The pinned network transport: DNS pinning plus the buffered HTTPS request
// the legacy /broker route speaks through.
import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { isIP } from 'node:net';
import { isPrivateIp } from '../../shared/ssrf-guard';
import { MAX_RESPONSE_BYTES, REQUEST_TIMEOUT_MS, SecretBrokerError } from './errors';
import type { BrokerTransportResponse, PreparedBrokerRequest } from './request-gate';

export async function resolvePinnedAddress(url: URL): Promise<{ address: string; family: 4 | 6 }> {
  if (isIP(url.hostname) !== 0) {
    if (isPrivateIp(url.hostname)) {
      throw new SecretBrokerError('unsafe_destination', 'destination IP is private or reserved', 403);
    }
    return { address: url.hostname, family: isIP(url.hostname) as 4 | 6 };
  }

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await dnsLookup(url.hostname, { all: true, verbatim: true });
  } catch {
    throw new SecretBrokerError('unsafe_destination', 'destination DNS lookup failed', 502);
  }
  if (addresses.length === 0 || addresses.some((entry) => isPrivateIp(entry.address))) {
    throw new SecretBrokerError(
      'unsafe_destination',
      'destination resolves to a private or reserved address',
      403,
    );
  }
  const selected = addresses[0];
  return { address: selected.address, family: selected.family === 6 ? 6 : 4 };
}

export function createPinnedRequestOptions(
  prepared: PreparedBrokerRequest,
  pinned: { address: string; family: 4 | 6 },
): RequestOptions {
  return {
    protocol: 'https:',
    hostname: pinned.address,
    family: pinned.family,
    port: prepared.url.port || 443,
    path: `${prepared.url.pathname}${prepared.url.search}`,
    method: prepared.method,
    headers: {
      ...prepared.headers,
      host: prepared.url.host,
    },
    servername: isIP(prepared.url.hostname) === 0 ? prepared.url.hostname : undefined,
  };
}

export async function pinnedHttpsTransport(
  prepared: PreparedBrokerRequest,
): Promise<BrokerTransportResponse> {
  const pinned = await resolvePinnedAddress(prepared.url);
  return await new Promise<BrokerTransportResponse>((resolve, reject) => {
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const request = httpsRequest(
      createPinnedRequestOptions(prepared, pinned),
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += buffer.byteLength;
          if (size > MAX_RESPONSE_BYTES) {
            response.destroy();
            fail(
              new SecretBrokerError(
                'response_too_large',
                'upstream response exceeds 5 MiB',
                502,
              ),
            );
            return;
          }
          chunks.push(buffer);
        });
        response.on('end', () => {
          if (settled) return;
          settled = true;
          const headers: Record<string, string | string[] | undefined> = {};
          for (const [name, value] of Object.entries(response.headers)) headers[name] = value;
          resolve({
            status: response.statusCode ?? 502,
            headers,
            body: Buffer.concat(chunks),
          });
        });
        response.on('error', fail);
      },
    );
    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      request.destroy();
      fail(new SecretBrokerError('upstream_timeout', 'upstream request timed out', 504));
    });
    request.on('error', (error) => {
      fail(
        error instanceof SecretBrokerError
          ? error
          : new SecretBrokerError('upstream_failed', 'upstream request failed', 502),
      );
    });
    if (prepared.body) request.write(prepared.body);
    request.end();
  });
}
