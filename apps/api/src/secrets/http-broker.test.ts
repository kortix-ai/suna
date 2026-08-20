import { describe, expect, test } from 'bun:test';
import type { SecretBrokerRequest } from '@kortix/api-contract';
import type { SecretEgressPolicy } from '@kortix/db';
import {
  createPinnedRequestOptions,
  executeSecretBrokerRequest,
  prepareSecretBrokerRequest,
  redactSecretFromResponse,
  SecretBrokerError,
  type BrokerTransport,
  type SecretSubstitution,
} from './http-broker';

const SECRET = 'local-secret-value';

function policy(
  overrides: Partial<SecretEgressPolicy> = {},
): SecretEgressPolicy {
  return {
    backend: 'kortix_fetch',
    rules: [{ host: 'api.example.com', methods: ['POST'], path: '/v1/*' }],
    inject: { kind: 'header', name: 'authorization', template: 'Bearer {{secret}}' },
    ...overrides,
  };
}

function request(overrides: Partial<SecretBrokerRequest> = {}): SecretBrokerRequest {
  return {
    url: 'https://api.example.com/v1/messages',
    method: 'POST',
    body_base64: Buffer.from('{}').toString('base64'),
    ...overrides,
  };
}

describe('prepareSecretBrokerRequest', () => {
  test('injects a managed header after the request matches host, method, and path', () => {
    const prepared = prepareSecretBrokerRequest(policy(), SECRET, request());
    expect(prepared.headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(prepared.headers['content-length']).toBe('2');
    expect(prepared.url.href).toBe('https://api.example.com/v1/messages');
  });

  test('denies host, method, and path mismatches', () => {
    for (const input of [
      request({ url: 'https://attacker.example/v1/messages' }),
      request({ method: 'DELETE' }),
      request({ url: 'https://api.example.com/v2/messages' }),
    ]) {
      expect(() => prepareSecretBrokerRequest(policy(), SECRET, input)).toThrow(SecretBrokerError);
    }
  });

  test('rejects non-HTTPS URLs, URL credentials, and managed caller headers', () => {
    for (const input of [
      request({ url: 'http://api.example.com/v1/messages' }),
      request({ url: 'https://user:pass@api.example.com/v1/messages' }),
      request({ headers: { authorization: 'caller-value' } }),
      request({ headers: { host: 'attacker.example' } }),
    ]) {
      expect(() => prepareSecretBrokerRequest(policy(), SECRET, input)).toThrow(SecretBrokerError);
    }
  });

  test('injects query and nested JSON fields without accepting prototype paths', () => {
    const query = prepareSecretBrokerRequest(
      policy({ inject: { kind: 'query', name: 'api_key' } }),
      SECRET,
      request(),
    );
    expect(query.url.searchParams.get('api_key')).toBe(SECRET);

    const json = prepareSecretBrokerRequest(
      policy({ inject: { kind: 'json_body_field', path: 'auth.api_key' } }),
      SECRET,
      request({ body_base64: Buffer.from('{"input":1}').toString('base64') }),
    );
    expect(JSON.parse(json.body!.toString('utf8'))).toEqual({
      input: 1,
      auth: { api_key: SECRET },
    });
    expect(() =>
      prepareSecretBrokerRequest(
        policy({ inject: { kind: 'json_body_field', path: '__proto__.api_key' } }),
        SECRET,
        request(),
      ),
    ).toThrow(SecretBrokerError);
  });

  test('rejects malformed base64 and request bodies larger than 1 MiB', () => {
    expect(() => prepareSecretBrokerRequest(policy(), SECRET, request({ body_base64: '%%%' }))).toThrow(
      SecretBrokerError,
    );
    expect(() =>
      prepareSecretBrokerRequest(
        policy(),
        SECRET,
        request({ body_base64: Buffer.alloc(1_048_577).toString('base64') }),
      ),
    ).toThrow(SecretBrokerError);
  });
});

describe('prepareSecretBrokerRequest blocked headers and port pinning', () => {
  // BREAK 2: a guest that sets `accept-encoding: gzip` would get a compressed
  // echo, and `redactSecretFromResponse` scans raw bytes — a gzipped secret
  // slips past it. The broker DROPS any caller value and forces `identity` on
  // its own upstream leg, so the response is always uncompressed. It must NOT
  // 400 on the header: the shim always sends `accept-encoding: identity`, and
  // 400ing it would break every relay and every already-deployed daemon.
  test('drops a caller accept-encoding and forces identity upstream', () => {
    const prepared = prepareSecretBrokerRequest(
      policy(),
      SECRET,
      request({ headers: { 'accept-encoding': 'gzip' } }),
    );
    expect(prepared.headers['accept-encoding']).toBe('identity');
  });

  test('forces identity even when the caller sends no accept-encoding', () => {
    const prepared = prepareSecretBrokerRequest(policy(), SECRET, request());
    expect(prepared.headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(prepared.headers['accept-encoding']).toBe('identity');
  });

  // FINDING 5: `matchRule` never sees the port, so an approved host would
  // otherwise accept the value on `:8443`. Egress is pinned to https/443.
  test('rejects an explicit non-443 port', () => {
    expect(() =>
      prepareSecretBrokerRequest(
        policy(),
        SECRET,
        request({ url: 'https://api.example.com:8443/v1/messages' }),
      ),
    ).toThrow(SecretBrokerError);
  });

  test('accepts an explicit :443 and an omitted port', () => {
    for (const url of [
      'https://api.example.com:443/v1/messages',
      'https://api.example.com/v1/messages',
    ]) {
      const prepared = prepareSecretBrokerRequest(policy(), SECRET, request({ url }));
      expect(prepared.url.hostname).toBe('api.example.com');
      expect(prepared.url.port).toBe('');
    }
  });
});

describe('executeSecretBrokerRequest', () => {
  test('returns only safe headers and redacts common secret representations', async () => {
    const transport: BrokerTransport = async () => ({
      status: 200,
      headers: {
        'content-type': 'application/json',
        'set-cookie': `secret=${SECRET}`,
        'x-request-id': 'req-1',
      },
      body: Buffer.from(
        JSON.stringify({
          raw: SECRET,
          encoded: encodeURIComponent(SECRET),
          base64: Buffer.from(SECRET).toString('base64'),
        }),
      ),
    });

    const response = await executeSecretBrokerRequest(policy(), SECRET, request(), { transport });
    expect(response.headers).toEqual({
      'content-type': 'application/json',
      'x-request-id': 'req-1',
    });
    const body = Buffer.from(response.body_base64, 'base64').toString('utf8');
    expect(body).not.toContain(SECRET);
    expect(body).not.toContain(Buffer.from(SECRET).toString('base64'));
  });

  // A redirect is only followed when NO secret is on the wire yet (hostsOnly
  // policy, no inject, no substitution): the second hop is re-gated against the
  // policy and an off-policy target is denied there. (A redirect AFTER a secret
  // is refused outright — see the substitution suite below.)
  test('revalidates a redirect against the secret policy when no secret is on the wire', async () => {
    const destinations: string[] = [];
    const transport: BrokerTransport = async (prepared) => {
      destinations.push(prepared.url.href);
      return destinations.length === 1
        ? {
            status: 307,
            headers: { location: 'https://attacker.example/collect' },
            body: Buffer.alloc(0),
          }
        : { status: 200, headers: {}, body: Buffer.from('unexpected') };
    };

    await expect(
      executeSecretBrokerRequest(hostsOnlyPolicy(), SECRET, request(), { transport }),
    ).rejects.toMatchObject({ code: 'policy_denied' });
    expect(destinations).toEqual(['https://api.example.com/v1/messages']);
  });

  test('caps redirects at three hops when no secret is on the wire', async () => {
    let calls = 0;
    const transport: BrokerTransport = async () => {
      calls += 1;
      return {
        status: 307,
        headers: { location: 'https://api.example.com/v1/messages' },
        body: Buffer.alloc(0),
      };
    };
    await expect(
      executeSecretBrokerRequest(hostsOnlyPolicy(), SECRET, request(), { transport }),
    ).rejects.toMatchObject({ code: 'upstream_failed' });
    expect(calls).toBe(4);
  });
});

test('redactSecretFromResponse handles repeated literal values', () => {
  const redacted = redactSecretFromResponse(Buffer.from(`${SECRET}:${SECRET}`), SECRET);
  expect(redacted.toString('utf8')).toBe('[REDACTED]:[REDACTED]');
});

test('pinned transport connects to the verified IP without a runtime DNS lookup', () => {
  // Port pinning (FINDING 5) now refuses any explicit non-443 port at
  // `prepareSecretBrokerRequest`, so the pinned-transport path is exercised on
  // the standard HTTPS port. The default 443 falls through to `|| 443`.
  const prepared = prepareSecretBrokerRequest(
    policy({ rules: [{ host: 'api.example.com', methods: ['POST'], path: '/v1/*' }] }),
    SECRET,
    request({ url: 'https://api.example.com/v1/messages' }),
  );
  const options = createPinnedRequestOptions(prepared, {
    address: '203.0.113.10',
    family: 4,
  });

  expect(options).toMatchObject({
    hostname: '203.0.113.10',
    port: 443,
    path: '/v1/messages',
    method: 'POST',
    servername: 'api.example.com',
    headers: {
      authorization: `Bearer ${SECRET}`,
      host: 'api.example.com',
    },
  });
  expect('lookup' in options).toBe(false);
});

// ── Substitution ────────────────────────────────────────────────────────────
//
// The egress-enforced path: the sandbox holds a HANDLE, sends it with an
// ordinary HTTP client, and the relay swaps it for the real value on the way
// out. See docs/specs/2026-08-19-secrets-exposure-usage-model.md §5.

const HANDLE = 'kortix_brokered__use_kortix_fetch__KXS1abcdefghijklmnopqrstuvwxyz234567ab';
const OTHER_HANDLE = 'kortix_brokered__use_kortix_fetch__KXS1zyxwvutsrqponmlkjihg765432abcdef';

function substitution(
  overrides: Partial<SecretSubstitution> = {},
): SecretSubstitution {
  return {
    identifier: 'PRIMARY',
    handle: HANDLE,
    value: SECRET,
    policy: policy(),
    ...overrides,
  };
}

/** A substitution-only row: hosts, and no `inject` at all (spec §6). */
function hostsOnlyPolicy(host = 'api.example.com'): SecretEgressPolicy {
  return { rules: [{ host }] } as unknown as SecretEgressPolicy;
}

describe('prepareSecretBrokerRequest substitution', () => {
  test('replaces a handle in a header, the query string, and the body', () => {
    const prepared = prepareSecretBrokerRequest(
      hostsOnlyPolicy(),
      SECRET,
      request({
        url: `https://api.example.com/v1/messages?key=${HANDLE}`,
        headers: { 'x-api-key': `Bearer ${HANDLE}` },
        body_base64: Buffer.from(JSON.stringify({ token: HANDLE })).toString('base64'),
      }),
      [substitution({ policy: hostsOnlyPolicy() })],
    );

    expect(prepared.headers['x-api-key']).toBe(`Bearer ${SECRET}`);
    expect(prepared.url.searchParams.get('key')).toBe(SECRET);
    expect(JSON.parse(prepared.body!.toString('utf8'))).toEqual({ token: SECRET });
    // The relay is fully buffered, so the framing it states must be the framing
    // it sends — the substituted body is longer than the one that arrived.
    expect(prepared.headers['content-length']).toBe(String(prepared.body!.byteLength));
    expect(prepared.substituted).toEqual(['PRIMARY']);
  });

  test('finds the handle in all four representations', () => {
    const jsonEscaped = JSON.stringify(HANDLE).slice(1, -1);
    const body = [
      `raw=${HANDLE}`,
      `url=${encodeURIComponent(HANDLE)}`,
      `base64=${Buffer.from(HANDLE).toString('base64')}`,
      `json=${jsonEscaped}`,
    ].join('&');

    const prepared = prepareSecretBrokerRequest(
      hostsOnlyPolicy(),
      SECRET,
      request({ body_base64: Buffer.from(body).toString('base64') }),
      [substitution({ policy: hostsOnlyPolicy() })],
    );

    const sent = prepared.body!.toString('utf8');
    expect(sent).not.toContain(HANDLE);
    expect(sent).toContain(`raw=${SECRET}`);
    expect(sent).toContain(`base64=${Buffer.from(SECRET).toString('base64')}`);
    // The base64 representation is replaced by the base64 of the VALUE, not by
    // the raw value — a representation-preserving swap, or the receiver decodes
    // garbage.
    expect(sent).not.toContain(Buffer.from(HANDLE).toString('base64'));
  });

  test('two secrets on one host are both substituted in one request', () => {
    const prepared = prepareSecretBrokerRequest(
      hostsOnlyPolicy(),
      SECRET,
      request({
        headers: { 'x-first': HANDLE, 'x-second': OTHER_HANDLE },
        body_base64: Buffer.from(`${HANDLE}|${OTHER_HANDLE}`).toString('base64'),
      }),
      [
        substitution({ policy: hostsOnlyPolicy() }),
        substitution({
          identifier: 'SECONDARY',
          handle: OTHER_HANDLE,
          value: 'second-secret-value',
          policy: hostsOnlyPolicy(),
        }),
      ],
    );

    expect(prepared.headers['x-first']).toBe(SECRET);
    expect(prepared.headers['x-second']).toBe('second-secret-value');
    expect(prepared.body!.toString('utf8')).toBe(`${SECRET}|second-secret-value`);
    expect(prepared.substituted.sort()).toEqual(['PRIMARY', 'SECONDARY']);
  });

  test('a handle whose own policy denies this host is left untouched', () => {
    // Substitution must never widen who may spend: the destination is admitted
    // for the ROUTE's secret, not for this one.
    const prepared = prepareSecretBrokerRequest(
      hostsOnlyPolicy(),
      SECRET,
      request({ headers: { 'x-other': OTHER_HANDLE } }),
      [
        substitution({
          identifier: 'ELSEWHERE',
          handle: OTHER_HANDLE,
          value: 'must-not-be-sent',
          policy: hostsOnlyPolicy('api.other.example'),
        }),
      ],
    );

    expect(prepared.headers['x-other']).toBe(OTHER_HANDLE);
    expect(prepared.substituted).toEqual([]);
    expect(JSON.stringify(prepared.headers)).not.toContain('must-not-be-sent');
  });

  test('a legacy inject policy still injects, and substitutes alongside it', () => {
    const prepared = prepareSecretBrokerRequest(
      policy(),
      SECRET,
      request({ headers: { 'x-api-key': HANDLE } }),
      [substitution()],
    );

    // Byte-identical to the pre-substitution behaviour for the injected header.
    expect(prepared.headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(prepared.headers['x-api-key']).toBe(SECRET);
  });

  test('refuses a compressed request body instead of relaying the handle', () => {
    // A gzipped body does not contain the handle's bytes, so the scan finds
    // nothing and the guest's credential reference leaves the building intact.
    expect(() =>
      prepareSecretBrokerRequest(
        hostsOnlyPolicy(),
        SECRET,
        request({ headers: { 'content-encoding': 'gzip' } }),
        [substitution({ policy: hostsOnlyPolicy() })],
      ),
    ).toThrow(SecretBrokerError);
  });

  test('refuses a substituted header value that would split the request', () => {
    expect(() =>
      prepareSecretBrokerRequest(
        hostsOnlyPolicy(),
        SECRET,
        request({ headers: { 'x-api-key': HANDLE } }),
        [substitution({ value: 'evil\r\nx-injected: 1', policy: hostsOnlyPolicy() })],
      ),
    ).toThrow(SecretBrokerError);
  });

  test('keeps a JSON body valid when the value itself needs escaping', () => {
    // The body's own content type decides which representation wins when the
    // handle's encodings collapse: inside JSON, a value carrying a quote has to
    // arrive escaped or the upstream parses garbage.
    const prepared = prepareSecretBrokerRequest(
      hostsOnlyPolicy(),
      SECRET,
      request({
        headers: { 'content-type': 'application/json' },
        body_base64: Buffer.from(JSON.stringify({ token: HANDLE })).toString('base64'),
      }),
      [substitution({ value: 'quote"and\\slash', policy: hostsOnlyPolicy() })],
    );

    expect(JSON.parse(prepared.body!.toString('utf8'))).toEqual({ token: 'quote"and\\slash' });
  });

  test('percent-encodes a substituted value in the query string', () => {
    const prepared = prepareSecretBrokerRequest(
      hostsOnlyPolicy(),
      SECRET,
      request({ url: `https://api.example.com/v1/messages?key=${HANDLE}` }),
      [substitution({ value: 'a&b=c', policy: hostsOnlyPolicy() })],
    );

    expect(prepared.url.search).toBe('?key=a%26b%3Dc');
    expect(prepared.url.searchParams.get('key')).toBe('a&b=c');
  });

  test('leaves a request with no admitted substitutions byte-identical', () => {
    const withNone = prepareSecretBrokerRequest(policy(), SECRET, request());
    const withEmpty = prepareSecretBrokerRequest(policy(), SECRET, request(), []);
    expect(withEmpty).toEqual(withNone);
    expect(withNone.substituted).toEqual([]);
  });
});

describe('executeSecretBrokerRequest substitution', () => {
  test('reports what it substituted and redacts those values from the echo', async () => {
    const applied = new Set<string>();
    const transport: BrokerTransport = async (prepared) => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ echoed: prepared.headers['x-api-key'] })),
    });

    const response = await executeSecretBrokerRequest(
      hostsOnlyPolicy(),
      'route-secret-value',
      request({ headers: { 'x-api-key': OTHER_HANDLE } }),
      {
        transport,
        applied,
        substitutions: [
          substitution({
            identifier: 'SECONDARY',
            handle: OTHER_HANDLE,
            value: 'second-secret-value',
            policy: hostsOnlyPolicy(),
          }),
        ],
      },
    );

    expect([...applied]).toEqual(['SECONDARY']);
    const body = Buffer.from(response.body_base64, 'base64').toString('utf8');
    expect(body).toBe('{"echoed":"[REDACTED]"}');
  });

  // BREAK 1 (fail-closed redirect): once a substitution has put the real value
  // on hop 1, a redirect is NOT followed — even when the upstream reflects that
  // value into `Location`. Per-hop admission does not protect this, because the
  // reflected bytes are no longer a handle. This REPLACES the old
  // "re-checks each substitution against the redirect target" test, which
  // asserted the redirect WAS followed after substitution — the insecure
  // behavior this finding closes.
  test('never follows a redirect after a value was substituted onto the wire', async () => {
    const seen: string[] = [];
    const transport: BrokerTransport = async (prepared) => {
      seen.push(prepared.url.href);
      // hop 1 carried the substituted value in the query; the upstream reflects
      // it into a Location pointing at an off-policy host — the exfil this fix
      // closes. The second request must NEVER be made.
      return {
        status: 302,
        headers: { location: `https://attacker.example/collect?leak=${SECRET}` },
        body: Buffer.alloc(0),
      };
    };

    await expect(
      executeSecretBrokerRequest(
        hostsOnlyPolicy(),
        SECRET,
        request({ url: `https://api.example.com/v1/messages?key=${HANDLE}` }),
        { transport, substitutions: [substitution({ policy: hostsOnlyPolicy() })] },
      ),
    ).rejects.toMatchObject({ code: 'upstream_failed' });

    // Exactly one hop was dialed: the substituted value (not the handle) reached
    // only the approved host, and the reflected redirect was never followed.
    expect(seen).toEqual([`https://api.example.com/v1/messages?key=${SECRET}`]);
  });

  test('still follows a redirect when NO secret was substituted onto the wire', async () => {
    const seen: string[] = [];
    const transport: BrokerTransport = async (prepared) => {
      seen.push(prepared.url.href);
      return seen.length === 1
        ? {
            status: 302,
            headers: { location: 'https://api.example.com/v1/second' },
            body: Buffer.alloc(0),
          }
        : { status: 200, headers: {}, body: Buffer.from('{}') };
    };

    // hostsOnly policy, no inject, no admitted substitution → carriesSecret is
    // false, so the redirect follows and hop 2 completes.
    const response = await executeSecretBrokerRequest(
      hostsOnlyPolicy(),
      SECRET,
      request(),
      { transport },
    );
    expect(response.status).toBe(200);
    expect(seen).toEqual([
      'https://api.example.com/v1/messages',
      'https://api.example.com/v1/second',
    ]);
  });

  // BREAK 3: response headers are whitelisted and returned verbatim, so a
  // reflected secret must be scrubbed there too — not only in the body.
  test('redacts the route secret reflected into content-type and etag headers', async () => {
    const transport: BrokerTransport = async () => ({
      status: 200,
      headers: {
        'content-type': `application/json; charset=${SECRET}`,
        etag: `"${SECRET}"`,
        'x-request-id': 'req-1',
      },
      body: Buffer.from('{}'),
    });

    const response = await executeSecretBrokerRequest(policy(), SECRET, request(), { transport });
    expect(response.headers['content-type']).toBe('application/json; charset=[REDACTED]');
    expect(response.headers.etag).toBe('"[REDACTED]"');
    expect(response.headers['x-request-id']).toBe('req-1');
  });

  test('redacts an applied substitution value reflected into a response header', async () => {
    const transport: BrokerTransport = async (prepared) => ({
      status: 200,
      headers: { etag: `"${prepared.headers['x-api-key']}"` },
      body: Buffer.alloc(0),
    });

    const response = await executeSecretBrokerRequest(
      hostsOnlyPolicy(),
      'route-secret-value',
      request({ headers: { 'x-api-key': OTHER_HANDLE } }),
      {
        transport,
        substitutions: [
          substitution({
            identifier: 'SECONDARY',
            handle: OTHER_HANDLE,
            value: 'second-secret-value',
            policy: hostsOnlyPolicy(),
          }),
        ],
      },
    );

    expect(response.headers.etag).toBe('"[REDACTED]"');
  });
});
