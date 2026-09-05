import { describe, expect, test } from 'bun:test';
import {
  RELAY_EOS_BYTES,
  RELAY_ERROR_HEADER,
  RELAY_META_HEADER,
  RELAY_META_MAX_BYTES,
  RELAY_PROBE_HEADER,
  RELAY_STATUS_HEADER,
  RELAY_TICKET_HEADER,
  RELAY_VERSION,
  RELAY_VERSION_HEADER,
  RelayCodecError,
  type SecretRelayMeta,
  decodeRelayMeta,
  decodeRelayStatus,
  encodeRelayMeta,
  encodeRelayStatus,
} from '../secret-relay';

const META: SecretRelayMeta = {
  v: 1,
  url: 'https://api.stripe.com/v1/charges?expand=x',
  method: 'POST',
  headers: [
    ['authorization', 'Bearer kortix_brokered__KXS1abc'],
    ['content-type', 'application/json'],
  ],
  body: { present: true, length: 312 },
};

describe('the relay meta codec round-trips exactly what the wire contract says', () => {
  test('round-trips a full meta unchanged', () => {
    expect(decodeRelayMeta(encodeRelayMeta(META))).toEqual(META);
  });

  test('preserves DUPLICATE headers and their ORDER', () => {
    // The whole reason headers ride in the meta instead of on the wire: Bun's
    // HTTP header parser silently collapses duplicate headers outside its
    // known-header table to the LAST value, so the API cannot recover the
    // guest's list from the request itself.
    const meta: SecretRelayMeta = {
      ...META,
      headers: [
        ['x-dup', 'one'],
        ['accept', 'text/event-stream'],
        ['x-dup', 'two'],
      ],
    };
    expect(decodeRelayMeta(encodeRelayMeta(meta)).headers).toEqual([
      ['x-dup', 'one'],
      ['accept', 'text/event-stream'],
      ['x-dup', 'two'],
    ]);
  });

  test('encodes base64url — no +, / or = that would need header quoting', () => {
    const encoded = encodeRelayMeta({
      ...META,
      url: 'https://api.stripe.com/v1/a?b=%F0%9F%92%B3&c=~~~???',
    });
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test('round-trips non-ASCII header values byte-exactly', () => {
    const meta: SecretRelayMeta = { ...META, headers: [['x-note', 'café — naïve']] };
    expect(decodeRelayMeta(encodeRelayMeta(meta)).headers[0]![1]).toBe('café — naïve');
  });

  test('a bodyless request encodes body.present false', () => {
    const meta: SecretRelayMeta = { ...META, method: 'GET', body: { present: false } };
    expect(decodeRelayMeta(encodeRelayMeta(meta)).body).toEqual({ present: false });
  });

  test('an unknown body length round-trips as null', () => {
    const meta: SecretRelayMeta = { ...META, body: { present: true, length: null } };
    expect(decodeRelayMeta(encodeRelayMeta(meta)).body).toEqual({ present: true, length: null });
  });
});

describe('the decoder is a security boundary, so it validates rather than trusts', () => {
  const decodes = (meta: unknown) =>
    decodeRelayMeta(Buffer.from(JSON.stringify(meta), 'utf8').toString('base64url'));

  test('rejects a non-https url', () => {
    expect(() => decodes({ ...META, url: 'http://api.stripe.com/v1' })).toThrow(RelayCodecError);
  });

  test('rejects a url carrying userinfo', () => {
    expect(() => decodes({ ...META, url: 'https://user:pw@api.stripe.com/v1' })).toThrow(
      RelayCodecError,
    );
  });

  test('rejects a relative url', () => {
    expect(() => decodes({ ...META, url: '/v1/charges' })).toThrow(RelayCodecError);
  });

  test('rejects an unknown method', () => {
    expect(() => decodes({ ...META, method: 'TRACE' })).toThrow(RelayCodecError);
  });

  test('rejects a header name with characters HTTP does not allow', () => {
    expect(() => decodes({ ...META, headers: [['bad name', 'x']] })).toThrow(RelayCodecError);
  });

  test('rejects CR or LF in a header value — response splitting', () => {
    expect(() => decodes({ ...META, headers: [['x-a', 'v\r\nx-injected: 1']] })).toThrow(
      RelayCodecError,
    );
    expect(() => decodes({ ...META, headers: [['x-a', 'v\nx']] })).toThrow(RelayCodecError);
  });

  test('rejects more than 64 headers', () => {
    const headers = Array.from({ length: 65 }, (_, i) => [`x-h${i}`, 'v'] as [string, string]);
    expect(() => decodes({ ...META, headers })).toThrow(RelayCodecError);
  });

  test('accepts exactly 64 headers', () => {
    const headers = Array.from({ length: 64 }, (_, i) => [`x-h${i}`, 'v'] as [string, string]);
    expect(decodes({ ...META, headers }).headers).toHaveLength(64);
  });

  test('rejects a protocol version it does not implement', () => {
    expect(() => decodes({ ...META, v: 2 })).toThrow(RelayCodecError);
  });

  test('rejects garbage that is not base64url JSON', () => {
    expect(() => decodeRelayMeta('!!!not base64!!!')).toThrow(RelayCodecError);
    expect(() => decodeRelayMeta(Buffer.from('{oops').toString('base64url'))).toThrow(
      RelayCodecError,
    );
  });

  test('rejects an encoded meta over the header budget', () => {
    const huge = 'x'.repeat(RELAY_META_MAX_BYTES);
    expect(() => decodeRelayMeta(huge)).toThrow(RelayCodecError);
  });

  test('refuses to ENCODE a meta that would exceed the header budget', () => {
    // Fail on the shim side rather than shipping a header the API must reject.
    const headers = Array.from(
      { length: 60 },
      (_, i) => [`x-h${i}`, 'v'.repeat(2000)] as [string, string],
    );
    expect(() => encodeRelayMeta({ ...META, headers })).toThrow(RelayCodecError);
  });

  test('rejects a negative or non-integer body length', () => {
    expect(() => decodes({ ...META, body: { present: true, length: -1 } })).toThrow(
      RelayCodecError,
    );
    expect(() => decodes({ ...META, body: { present: true, length: 1.5 } })).toThrow(
      RelayCodecError,
    );
  });
});

describe('the relay status codec carries the UPSTREAM verdict', () => {
  test('round-trips status and ordered headers', () => {
    const status = {
      v: RELAY_VERSION,
      status: 429,
      headers: [
        ['content-type', 'application/json'],
        ['retry-after', '5'],
      ] as Array<[string, string]>,
    };
    expect(decodeRelayStatus(encodeRelayStatus(status))).toEqual(status);
  });

  test('rejects a status code outside 100..599', () => {
    expect(() =>
      decodeRelayStatus(
        Buffer.from(JSON.stringify({ v: 1, status: 99, headers: [] })).toString('base64url'),
      ),
    ).toThrow(RelayCodecError);
  });
});

describe('the control header names are the contract', () => {
  test('every header name is fixed and lowercase', () => {
    // These strings ARE the wire contract. A daemon baked into a sandbox image
    // months ago still sends them, so they are pinned here rather than left to
    // whatever each side happens to type.
    expect(RELAY_VERSION_HEADER).toBe('x-kortix-relay');
    expect(RELAY_META_HEADER).toBe('x-kortix-relay-meta');
    expect(RELAY_STATUS_HEADER).toBe('x-kortix-relay-status');
    expect(RELAY_ERROR_HEADER).toBe('x-kortix-relay-error');
    expect(RELAY_PROBE_HEADER).toBe('x-kortix-relay-probe');
    expect(RELAY_TICKET_HEADER).toBe('x-kortix-relay-ticket');
    expect(RELAY_META_MAX_BYTES).toBe(65536);
    expect(RELAY_VERSION).toBe(1);
  });
});

/**
 * The end-of-stream sentinel fields.
 *
 * Both are ADDITIVE and OPTIONAL, and that is the whole compatibility story: a
 * daemon baked before this existed sends no `meta.eos`, so the API mints no
 * `status.eos` and the wire is byte-for-byte what it was. The protocol version
 * therefore stays at 1 — bumping it would refuse every already-deployed daemon.
 */
describe('the end-of-stream sentinel is an optional, additive field', () => {
  test('meta round-trips eos: true', () => {
    const meta = decodeRelayMeta(
      encodeRelayMeta({
        v: 1,
        url: 'https://api.example.com/v1/x',
        method: 'POST',
        headers: [['content-type', 'application/json']],
        body: { present: true, length: 2 },
        eos: true,
      }),
    );
    expect(meta.eos).toBe(true);
  });

  test('a meta with NO eos decodes without one — an old daemon is unchanged', () => {
    const meta = decodeRelayMeta(
      encodeRelayMeta({
        v: 1,
        url: 'https://api.example.com/v1/x',
        method: 'GET',
        headers: [],
        body: { present: false },
      }),
    );
    expect(meta.eos).toBeUndefined();
  });

  test('a non-boolean eos is refused', () => {
    const encoded = Buffer.from(
      JSON.stringify({
        v: 1,
        url: 'https://api.example.com/v1/x',
        method: 'GET',
        headers: [],
        body: { present: false },
        eos: 'yes',
      }),
      'utf8',
    ).toString('base64url');
    expect(() => decodeRelayMeta(encoded)).toThrow(RelayCodecError);
  });

  test('status round-trips a hex sentinel of exactly RELAY_EOS_BYTES', () => {
    const eos = 'ab'.repeat(RELAY_EOS_BYTES);
    const status = decodeRelayStatus(encodeRelayStatus({ v: 1, status: 200, headers: [], eos }));
    expect(status.eos).toBe(eos);
    expect(Buffer.from(status.eos!, 'hex').byteLength).toBe(RELAY_EOS_BYTES);
  });

  test('a sentinel of the wrong length or alphabet is refused', () => {
    for (const bad of ['ab', 'AB'.repeat(RELAY_EOS_BYTES), 'zz'.repeat(RELAY_EOS_BYTES)]) {
      const encoded = Buffer.from(
        JSON.stringify({ v: 1, status: 200, headers: [], eos: bad }),
        'utf8',
      ).toString('base64url');
      expect(() => decodeRelayStatus(encoded)).toThrow(RelayCodecError);
    }
  });
});
