import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { isIP } from 'node:net';
import type {
  SecretBrokerRequest,
  SecretBrokerResponse,
} from '@kortix/api-contract';
import type { SecretEgressPolicy, SecretInjectionSlot } from '@kortix/db';
import { isPrivateIp } from '../shared/ssrf-guard';
import { matchRule } from './strategy';

const MAX_REQUEST_BYTES = 1_048_576;
const MAX_RESPONSE_BYTES = 5_242_880;
const MAX_REDIRECTS = 3;
const REQUEST_TIMEOUT_MS = 30_000;
const REDACTED = Buffer.from('[REDACTED]');

const BLOCKED_REQUEST_HEADERS = new Set([
  'authorization',
  'connection',
  'content-length',
  'cookie',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const SAFE_RESPONSE_HEADERS = new Set([
  'cache-control',
  'content-language',
  'content-type',
  'etag',
  'last-modified',
  'ratelimit-limit',
  'ratelimit-remaining',
  'ratelimit-reset',
  'retry-after',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
  'x-request-id',
]);

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export type SecretBrokerErrorCode =
  | 'invalid_request'
  | 'policy_denied'
  | 'unsafe_destination'
  | 'upstream_failed'
  | 'upstream_timeout'
  | 'response_too_large';

export class SecretBrokerError extends Error {
  constructor(
    readonly code: SecretBrokerErrorCode,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'SecretBrokerError';
  }
}

export interface PreparedBrokerRequest {
  url: URL;
  method: SecretBrokerRequest['method'];
  headers: Record<string, string>;
  body: Buffer | null;
}

export interface BrokerTransportResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

export type BrokerTransport = (
  request: PreparedBrokerRequest,
) => Promise<BrokerTransportResponse>;

function decodeBody(value: string | undefined): Buffer | null {
  if (value === undefined) return null;
  if (!BASE64.test(value)) {
    throw new SecretBrokerError('invalid_request', 'body_base64 is invalid', 400);
  }
  const body = Buffer.from(value, 'base64');
  if (body.byteLength > MAX_REQUEST_BYTES) {
    throw new SecretBrokerError('invalid_request', 'request body exceeds 1 MiB', 413);
  }
  return body;
}

function sanitizeHeaders(input: Record<string, string> | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [rawName, value] of Object.entries(input ?? {})) {
    const name = rawName.trim().toLowerCase();
    if (!HEADER_NAME.test(name)) {
      throw new SecretBrokerError('invalid_request', `invalid request header: ${rawName}`, 400);
    }
    if (BLOCKED_REQUEST_HEADERS.has(name)) {
      throw new SecretBrokerError('invalid_request', `request header is managed by dosco: ${name}`, 400);
    }
    if (value.includes('\r') || value.includes('\n')) {
      throw new SecretBrokerError('invalid_request', `invalid request header value: ${name}`, 400);
    }
    headers[name] = value;
  }
  return headers;
}

function injectedValue(slot: SecretInjectionSlot, secret: string): string {
  if (slot.kind !== 'header') return secret;
  const value = slot.template === undefined ? secret : slot.template.replaceAll('{{secret}}', secret);
  if (value.includes('\r') || value.includes('\n')) {
    throw new SecretBrokerError('invalid_request', 'managed header value is invalid', 400);
  }
  if (slot.template === undefined) return value;
  if (!slot.template.includes('{{secret}}')) {
    throw new SecretBrokerError(
      'invalid_request',
      'header injection template must contain {{secret}}',
      400,
    );
  }
  return value;
}

function injectJsonBody(body: Buffer | null, path: string, secret: string): Buffer {
  const segments = path.split('.');
  if (
    segments.length === 0 ||
    segments.length > 16 ||
    segments.some(
      (segment) =>
        !segment ||
        segment === '__proto__' ||
        segment === 'prototype' ||
        segment === 'constructor',
    )
  ) {
    throw new SecretBrokerError('invalid_request', 'invalid JSON injection path', 400);
  }

  let parsed: unknown = {};
  if (body && body.byteLength > 0) {
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      throw new SecretBrokerError('invalid_request', 'JSON body injection requires valid JSON', 400);
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SecretBrokerError('invalid_request', 'JSON body injection requires an object', 400);
  }

  let cursor = parsed as Record<string, unknown>;
  for (const segment of segments.slice(0, -1)) {
    const next = cursor[segment];
    if (next === undefined) {
      cursor[segment] = {};
    } else if (!next || typeof next !== 'object' || Array.isArray(next)) {
      throw new SecretBrokerError('invalid_request', 'JSON injection path is not an object', 400);
    }
    cursor = cursor[segment] as Record<string, unknown>;
  }
  cursor[segments.at(-1)!] = secret;

  const result = Buffer.from(JSON.stringify(parsed));
  if (result.byteLength > MAX_REQUEST_BYTES) {
    throw new SecretBrokerError('invalid_request', 'request body exceeds 1 MiB after injection', 413);
  }
  return result;
}

export function prepareSecretBrokerRequest(
  policy: SecretEgressPolicy,
  secret: string,
  input: SecretBrokerRequest,
): PreparedBrokerRequest {
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    throw new SecretBrokerError('invalid_request', 'url is invalid', 400);
  }
  if (url.protocol !== 'https:') {
    throw new SecretBrokerError('unsafe_destination', 'url must use HTTPS', 400);
  }
  if (url.username || url.password) {
    throw new SecretBrokerError('unsafe_destination', 'url must not contain credentials', 400);
  }

  const method = input.method ?? 'GET';
  const rule = matchRule(policy, { host: url.hostname, method, path: url.pathname });
  if (!rule) {
    throw new SecretBrokerError('policy_denied', 'outbound request does not match the secret policy', 403);
  }

  let body = decodeBody(input.body_base64);
  if ((method === 'GET' || method === 'HEAD') && body && body.byteLength > 0) {
    throw new SecretBrokerError('invalid_request', `${method} requests cannot contain a body`, 400);
  }
  const headers = sanitizeHeaders(input.headers);
  const slot = rule.inject ?? policy.inject;
  if (slot.kind === 'header') {
    const name = slot.name.trim().toLowerCase();
    if (!HEADER_NAME.test(name) || name === 'host' || name === 'content-length') {
      throw new SecretBrokerError('invalid_request', 'invalid managed header name', 400);
    }
    headers[name] = injectedValue(slot, secret);
  } else if (slot.kind === 'query') {
    url.searchParams.set(slot.name, secret);
  } else {
    body = injectJsonBody(body, slot.path, secret);
    headers['content-type'] = 'application/json';
  }
  if (body) headers['content-length'] = String(body.byteLength);

  return { url, method, headers, body };
}

async function resolvePinnedAddress(url: URL): Promise<{ address: string; family: 4 | 6 }> {
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

function replaceBuffer(source: Buffer, needle: Buffer): Buffer {
  if (needle.byteLength === 0) return source;
  const chunks: Buffer[] = [];
  let cursor = 0;
  for (;;) {
    const index = source.indexOf(needle, cursor);
    if (index === -1) break;
    chunks.push(source.subarray(cursor, index), REDACTED);
    cursor = index + needle.byteLength;
  }
  if (cursor === 0) return source;
  chunks.push(source.subarray(cursor));
  return Buffer.concat(chunks);
}

export function redactSecretFromResponse(body: Buffer, secret: string): Buffer {
  const jsonEscaped = JSON.stringify(secret).slice(1, -1);
  const representations = [
    secret,
    encodeURIComponent(secret),
    Buffer.from(secret).toString('base64'),
    jsonEscaped,
  ];
  let result = body;
  for (const representation of new Set(representations)) {
    result = replaceBuffer(result, Buffer.from(representation));
  }
  return result;
}

function responseHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase();
    if (!SAFE_RESPONSE_HEADERS.has(normalized) || value === undefined) continue;
    safe[normalized] = Array.isArray(value) ? value.join(', ') : value;
  }
  return safe;
}

function redirectedInput(
  input: SecretBrokerRequest,
  location: string,
  status: number,
): SecretBrokerRequest {
  const nextUrl = new URL(location, input.url).href;
  if (status === 303 || ((status === 301 || status === 302) && input.method === 'POST')) {
    return { url: nextUrl, method: 'GET', headers: input.headers };
  }
  return { ...input, url: nextUrl };
}

export async function executeSecretBrokerRequest(
  policy: SecretEgressPolicy,
  secret: string,
  input: SecretBrokerRequest,
  transport: BrokerTransport = pinnedHttpsTransport,
): Promise<SecretBrokerResponse> {
  let current = input;
  for (let redirects = 0; ; redirects += 1) {
    const prepared = prepareSecretBrokerRequest(policy, secret, current);
    const upstream = await transport(prepared);
    if ([301, 302, 303, 307, 308].includes(upstream.status)) {
      const rawLocation = upstream.headers.location;
      const location = Array.isArray(rawLocation) ? rawLocation[0] : rawLocation;
      if (!location) {
        throw new SecretBrokerError('upstream_failed', 'upstream redirect has no location', 502);
      }
      if (redirects >= MAX_REDIRECTS) {
        throw new SecretBrokerError('upstream_failed', 'upstream redirect limit exceeded', 502);
      }
      current = redirectedInput(current, location, upstream.status);
      continue;
    }
    const body = redactSecretFromResponse(upstream.body, secret);
    return {
      status: upstream.status,
      headers: responseHeaders(upstream.headers),
      body_base64: body.toString('base64'),
    };
  }
}
