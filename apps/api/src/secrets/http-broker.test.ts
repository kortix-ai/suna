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

    const response = await executeSecretBrokerRequest(policy(), SECRET, request(), transport);
    expect(response.headers).toEqual({
      'content-type': 'application/json',
      'x-request-id': 'req-1',
    });
    const body = Buffer.from(response.body_base64, 'base64').toString('utf8');
    expect(body).not.toContain(SECRET);
    expect(body).not.toContain(Buffer.from(SECRET).toString('base64'));
  });

  test('revalidates every redirect against the secret policy', async () => {
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
      executeSecretBrokerRequest(policy(), SECRET, request(), transport),
    ).rejects.toMatchObject({ code: 'policy_denied' });
    expect(destinations).toEqual(['https://api.example.com/v1/messages']);
  });

  test('caps redirects at three hops', async () => {
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
      executeSecretBrokerRequest(policy(), SECRET, request(), transport),
    ).rejects.toMatchObject({ code: 'upstream_failed' });
    expect(calls).toBe(4);
  });
});

test('redactSecretFromResponse handles repeated literal values', () => {
  const redacted = redactSecretFromResponse(Buffer.from(`${SECRET}:${SECRET}`), SECRET);
  expect(redacted.toString('utf8')).toBe('[REDACTED]:[REDACTED]');
});

test('pinned transport connects to the verified IP without a runtime DNS lookup', () => {
  const prepared = prepareSecretBrokerRequest(
    policy({ rules: [{ host: 'api.example.com', methods: ['POST'], path: '/v1/*' }] }),
    SECRET,
    request({ url: 'https://api.example.com:8443/v1/messages' }),
  );
  const options = createPinnedRequestOptions(prepared, {
    address: '203.0.113.10',
    family: 4,
  });

  expect(options).toMatchObject({
    hostname: '203.0.113.10',
    port: '8443',
    path: '/v1/messages',
    method: 'POST',
    servername: 'api.example.com',
    headers: {
      authorization: `Bearer ${SECRET}`,
      host: 'api.example.com:8443',
    },
  });
  expect('lookup' in options).toBe(false);
});
