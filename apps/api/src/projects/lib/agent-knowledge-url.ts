import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;

export class AgentKnowledgeUrlError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'AgentKnowledgeUrlError';
  }
}

function ipv4Parts(address: string): number[] | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const numbers = parts.map(Number);
  return numbers.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? numbers
    : null;
}

function forbiddenIpv4(address: string): boolean {
  const parts = ipv4Parts(address);
  if (!parts) return true;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19 || b === 51)) ||
    (a === 203 && b === 0) ||
    a >= 224
  );
}

export function isForbiddenKnowledgeAddress(address: string): boolean {
  const normalized = address.trim().toLowerCase().replace(/^\[|\]$/g, '');
  const family = isIP(normalized);
  if (family === 4) return forbiddenIpv4(normalized);
  if (family !== 6) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
  if (mapped) return forbiddenIpv4(mapped[1]!);
  return (
    normalized === '::' ||
    normalized === '::1' ||
    /^f[cd]/.test(normalized) ||
    /^fe[89ab]/.test(normalized) ||
    /^ff/.test(normalized) ||
    /^2001:db8(?::|$)/.test(normalized)
  );
}

export interface ResolvedKnowledgeAddress {
  address: string;
  family: 4 | 6;
}

export interface KnowledgeUrlResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

export interface FetchAgentKnowledgeUrlOptions {
  maxBytes?: number;
  maxRedirects?: number;
  timeoutMs?: number;
  resolve?: (hostname: string) => Promise<ResolvedKnowledgeAddress[]>;
  request?: (
    url: URL,
    address: ResolvedKnowledgeAddress,
    options: { maxBytes: number; timeoutMs: number },
  ) => Promise<KnowledgeUrlResponse>;
}

function validateUrl(url: URL): void {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AgentKnowledgeUrlError('invalid_protocol', 'Knowledge URLs must use HTTP or HTTPS.');
  }
  if (url.username || url.password) {
    throw new AgentKnowledgeUrlError('credentials_not_allowed', 'Knowledge URLs cannot contain credentials.');
  }
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  if (port !== '80' && port !== '443') {
    throw new AgentKnowledgeUrlError('port_not_allowed', 'Knowledge URLs must use port 80 or 443.');
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname === 'metadata.google.internal'
  ) {
    throw new AgentKnowledgeUrlError('forbidden_target', 'Knowledge URL target is not public.');
  }
}

async function defaultResolve(hostname: string): Promise<ResolvedKnowledgeAddress[]> {
  if (isIP(hostname)) {
    return [{ address: hostname, family: isIP(hostname) as 4 | 6 }];
  }
  const results = await lookup(hostname, { all: true, verbatim: true });
  return results.map((entry) => ({ address: entry.address, family: entry.family as 4 | 6 }));
}

async function defaultRequest(
  url: URL,
  pinned: ResolvedKnowledgeAddress,
  options: { maxBytes: number; timeoutMs: number },
): Promise<KnowledgeUrlResponse> {
  return new Promise((resolve, reject) => {
    const requestImpl = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const request = requestImpl(
      url,
      {
        headers: {
          accept: 'text/html,application/xhtml+xml,text/plain,text/csv;q=0.9,*/*;q=0.1',
          'user-agent': 'Kortix-Knowledge-Sync/1.0',
        },
        lookup: ((_hostname: string, _options: unknown, callback: (...args: unknown[]) => void) => {
          callback(null, pinned.address, pinned.family);
        }) as never,
      },
      (response) => {
        const headers = Object.fromEntries(
          Object.entries(response.headers).map(([key, value]) => [
            key.toLowerCase(),
            Array.isArray(value) ? value.join(', ') : String(value ?? ''),
          ]),
        );
        const declared = Number(headers['content-length'] ?? '0');
        if (Number.isFinite(declared) && declared > options.maxBytes) {
          response.destroy();
          reject(
            new AgentKnowledgeUrlError(
              'response_too_large',
              `Knowledge URL response exceeds ${options.maxBytes} bytes.`,
            ),
          );
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        response.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total > options.maxBytes) {
            response.destroy(
              new AgentKnowledgeUrlError(
                'response_too_large',
                `Knowledge URL response exceeds ${options.maxBytes} bytes.`,
              ),
            );
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          resolve({ status: response.statusCode ?? 0, headers, body: Buffer.concat(chunks) });
        });
        response.on('error', reject);
      },
    );
    request.setTimeout(options.timeoutMs, () => {
      request.destroy(new AgentKnowledgeUrlError('request_timeout', 'Knowledge URL request timed out.'));
    });
    request.on('error', reject);
    request.end();
  });
}

export async function fetchAgentKnowledgeUrl(
  value: string,
  options: FetchAgentKnowledgeUrlOptions = {},
): Promise<{ url: string; contentType: string; body: Uint8Array }> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRedirects = options.maxRedirects ?? 5;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const resolveHost = options.resolve ?? defaultResolve;
  const request = options.request ?? defaultRequest;
  let current: URL;
  try {
    current = new URL(value);
  } catch {
    throw new AgentKnowledgeUrlError('invalid_url', 'Knowledge URL is invalid.');
  }

  for (let redirectCount = 0; ; redirectCount += 1) {
    validateUrl(current);
    const addresses = await resolveHost(current.hostname);
    if (addresses.length === 0 || addresses.some((entry) => isForbiddenKnowledgeAddress(entry.address))) {
      throw new AgentKnowledgeUrlError('forbidden_target', 'Knowledge URL target is not public.');
    }
    const response = await request(current, addresses[0]!, { maxBytes, timeoutMs });
    if (response.body.byteLength > maxBytes) {
      throw new AgentKnowledgeUrlError(
        'response_too_large',
        `Knowledge URL response exceeds ${maxBytes} bytes.`,
      );
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (redirectCount >= maxRedirects) {
        throw new AgentKnowledgeUrlError('too_many_redirects', 'Knowledge URL redirected too many times.');
      }
      const location = response.headers.location;
      if (!location) {
        throw new AgentKnowledgeUrlError('invalid_redirect', 'Knowledge URL redirect has no location.');
      }
      current = new URL(location, current);
      continue;
    }
    if (response.status < 200 || response.status >= 300) {
      throw new AgentKnowledgeUrlError(
        'upstream_error',
        `Knowledge URL returned HTTP ${response.status}.`,
      );
    }
    return {
      url: current.toString(),
      contentType: response.headers['content-type']?.split(';')[0]?.trim().toLowerCase() ?? '',
      body: response.body,
    };
  }
}
