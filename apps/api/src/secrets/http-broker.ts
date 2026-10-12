// The buffered-route orchestrator over the modules in `broker/`; the moved
// concerns are re-exported below, so every existing import path keeps resolving.
import type { SecretBrokerRequest, SecretBrokerResponse } from '@kortix/api-contract';
import type { SecretEgressPolicy } from '@kortix/db';
import { MAX_REDIRECTS, SAFE_RESPONSE_HEADERS, SecretBrokerError } from './broker/errors';
import { redactSecretFromResponse, type SecretSubstitution } from './broker/substitution';
import { prepareSecretBrokerRequest, type BrokerTransport } from './broker/request-gate';
import { pinnedHttpsTransport } from './broker/pinned-transport';

export { MAX_REDIRECTS, REDACTED, SAFE_RESPONSE_HEADERS, SecretBrokerError } from './broker/errors';
export {
  bodyEncoding,
  encodeSecretRepresentation,
  redactSecretFromResponse,
  secretRepresentations,
  substituteBuffer,
} from './broker/substitution';
export type { SecretEncoding, SecretSubstitution } from './broker/substitution';
export { assertPolicyAdmitsPath, prepareRelayHead, prepareSecretBrokerRequest } from './broker/request-gate';
export type { BrokerTransport, PreparedRelayHead } from './broker/request-gate';
export { createPinnedRequestOptions, resolvePinnedAddress } from './broker/pinned-transport';

export function responseHeaders(
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

interface SecretBrokerExecuteOptions {
  transport?: BrokerTransport;
  /** Other secrets this session may spend on this destination, keyed to the
   *  handle that stands in for each of them inside the sandbox. */
  substitutions?: readonly SecretSubstitution[];
  /** Filled with the identifiers actually substituted, for the audit record.
   *  An out-param rather than a return field because the return type is the
   *  wire contract (`SecretBrokerResponse`) and audit is not part of it. */
  applied?: Set<string>;
}

export async function executeSecretBrokerRequest(
  policy: SecretEgressPolicy,
  secret: string,
  input: SecretBrokerRequest,
  options: SecretBrokerExecuteOptions = {},
): Promise<SecretBrokerResponse> {
  const transport = options.transport ?? pinnedHttpsTransport;
  const substitutions = options.substitutions ?? [];
  const applied = options.applied ?? new Set<string>();
  let current = input;
  for (let redirects = 0; ; redirects += 1) {
    const prepared = prepareSecretBrokerRequest(policy, secret, current, substitutions);
    for (const identifier of prepared.substituted) applied.add(identifier);
    const upstream = await transport(prepared);
    if ([301, 302, 303, 307, 308].includes(upstream.status)) {
      // A redirect only matters BEFORE any real credential is on the wire. Once
      // this hop has carried a secret (a substitution fired, or the route's own
      // secret was injected) the value is already delivered, and following the
      // `Location` would carry the substituted bytes — or a value the upstream
      // reflected into `Location` — to a host re-gated only by the ROUTE
      // secret's policy, never by the substituted secret's own. Fail closed.
      if (prepared.carriesSecret) {
        throw new SecretBrokerError(
          'upstream_failed',
          'redirect after secret substitution is not followed',
          502,
        );
      }
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
    // Redact the injected secret AND every secret substituted into the
    // request. A handle the guest sent is a secret the upstream can echo, so
    // an echo guard that only knew about the route's own identifier would hand
    // the other values straight back.
    // Every secret that could appear in this response: the route's own injected
    // secret, plus every substituted value that actually rode out on the wire.
    const secretsToRedact = [
      secret,
      ...substitutions
        .filter((substitution) => applied.has(substitution.identifier))
        .map((substitution) => substitution.value),
    ];

    let body = upstream.body;
    for (const value of secretsToRedact) {
      body = redactSecretFromResponse(body, value);
    }

    // The whitelisted response headers travel back verbatim, so an upstream can
    // reflect a substituted value into `content-type`, `etag`, `x-request-id`,
    // etc. Run each header value through the SAME redaction as the body — the
    // body alone is not the only exit.
    const headers = responseHeaders(upstream.headers);
    for (const [name, headerValue] of Object.entries(headers)) {
      let redacted: Buffer = Buffer.from(headerValue);
      for (const value of secretsToRedact) {
        redacted = redactSecretFromResponse(redacted, value);
      }
      headers[name] = redacted.toString('utf8');
    }

    return {
      status: upstream.status,
      headers,
      body_base64: body.toString('base64'),
    };
  }
}
