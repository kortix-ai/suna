import { describe, expect, test } from 'bun:test';
import { StreamSubstituter, substituteWholeBuffer, type StreamReplacement } from './stream-substitute';

const HANDLE = 'kortix_brokered__use_kortix_fetch__KXS1abcdefghijklmnopqrstuvwxyz234567ab';
const VALUE = 'sk_live_the_real_value';

function pair(needle: string, replacement: string, label?: string): StreamReplacement {
  return { needle: Buffer.from(needle), replacement: Buffer.from(replacement), ...(label ? { label } : {}) };
}

/** Feed `input` through the substituter in fixed-size chunks. */
function stream(input: string | Buffer, pairs: StreamReplacement[], chunkSize: number): string {
  const source = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const substituter = new StreamSubstituter(pairs);
  const out: Buffer[] = [];
  for (let i = 0; i < source.byteLength; i += chunkSize) {
    out.push(substituter.push(source.subarray(i, i + chunkSize)));
  }
  out.push(substituter.flush());
  return Buffer.concat(out).toString('utf8');
}

describe('StreamSubstituter replaces across chunk boundaries', () => {
  const pairs = [pair(HANDLE, VALUE, 'PRIMARY')];

  test('replaces a needle contained in one chunk', () => {
    expect(stream(`Bearer ${HANDLE}`, pairs, 4096)).toBe(`Bearer ${VALUE}`);
  });

  test('replaces a needle SPLIT across two chunks — the whole reason this exists', () => {
    // The exact failure a naive per-chunk replace has: the handle straddles the
    // boundary, so neither chunk contains it and the upstream gets the handle.
    const body = `Authorization: Bearer ${HANDLE}\r\n\r\n`;
    const split = 30; // lands inside the handle
    expect(split).toBeLessThan(body.indexOf(HANDLE) + HANDLE.length);
    expect(stream(body, pairs, split)).toBe(`Authorization: Bearer ${VALUE}\r\n\r\n`);
  });

  test('replaces a needle delivered ONE BYTE AT A TIME', () => {
    expect(stream(`x${HANDLE}y`, pairs, 1)).toBe(`x${VALUE}y`);
  });

  test('is correct for EVERY chunk size over the same input', () => {
    const body = `a${HANDLE}b${HANDLE}c`;
    const expected = `a${VALUE}b${VALUE}c`;
    for (let size = 1; size <= body.length + 2; size += 1) {
      expect(stream(body, pairs, size)).toBe(expected);
    }
  });

  test('passes through a stream with no match, unchanged', () => {
    const body = 'no handles here, just ordinary bytes'.repeat(50);
    for (const size of [1, 7, 4096]) expect(stream(body, pairs, size)).toBe(body);
  });

  test('emits a partial needle at end-of-stream as plain data', () => {
    // Nothing can complete it, so it is data, not a handle.
    const truncated = HANDLE.slice(0, 20);
    expect(stream(`tail:${truncated}`, pairs, 3)).toBe(`tail:${truncated}`);
  });

  test('reports which labels actually matched', () => {
    const substituter = new StreamSubstituter([pair(HANDLE, VALUE, 'PRIMARY'), pair('other', 'x', 'SECOND')]);
    substituter.push(Buffer.from(`${HANDLE} and more`));
    substituter.flush();
    expect(substituter.applied).toEqual(['PRIMARY']);
  });

  test('never re-scans replacement bytes', () => {
    // The replacement itself contains the needle. A second pass would rewrite it
    // again and again; the consumed-cursor invariant forbids that.
    const substituter = new StreamSubstituter([pair('AA', 'AAA')]);
    const out = Buffer.concat([substituter.push(Buffer.from('AA')), substituter.flush()]).toString();
    expect(out).toBe('AAA');
  });

  test('a needle that is a prefix of another does not shadow it', () => {
    const pairs2 = [pair('abc', 'SHORT'), pair('abcdef', 'LONG')];
    expect(stream('abcdef', pairs2, 1)).toBe('LONG');
  });

  test('with no pairs it is a zero-copy pass-through', () => {
    const substituter = new StreamSubstituter([]);
    expect(substituter.isPassThrough).toBe(true);
    const chunk = Buffer.from('anything at all');
    expect(substituter.push(chunk)).toBe(chunk); // same object, no copy
  });

  test('memory is bounded by the needle, not the body', () => {
    // The property that removes the size caps: a 5 MiB body with no match must
    // never retain more than (needleLength - 1) bytes.
    const substituter = new StreamSubstituter(pairs);
    const big = Buffer.alloc(5 * 1024 * 1024, 0x61);
    let emitted = 0;
    for (let i = 0; i < big.byteLength; i += 64 * 1024) {
      emitted += substituter.push(big.subarray(i, i + 64 * 1024)).byteLength;
    }
    emitted += substituter.flush().byteLength;
    expect(emitted).toBe(big.byteLength);
    // Bounded by the longest needle — never by the body. Asserted on the REAL
    // retained buffer rather than a declared window: retention is now decided
    // per chunk by `cutoffFor`, and the bound it guarantees is strictly tighter
    // (`longest - 1`, because only a PROPER prefix is ever held back).
    expect((substituter as unknown as { pending: Buffer }).pending.byteLength).toBeLessThan(
      Math.max(...pairs.map((p) => p.needle.byteLength)),
    );
  });
});

describe('promptness: bytes that cannot become a needle are emitted IMMEDIATELY', () => {
  // The regression this whole streaming relay exists to prevent. Blind
  // `longestNeedle` retention withheld the tail of EVERY chunk until the next
  // one arrived — measured at 1503 ms of added latency per 29-byte SSE event
  // for a 53-byte API key, and a whole-stream collapse for a PEM. On a
  // long-lived SSE stream the final event was withheld until the connection
  // closed, i.e. indefinitely. A relay that streams bytes but not EVENTS passes
  // a throughput test and fails every real user.
  const pairs = [pair(HANDLE, VALUE, 'PRIMARY')];

  test('a complete SSE event is forwarded whole, nothing withheld', () => {
    const substituter = new StreamSubstituter(pairs);
    const event = Buffer.from('data: {"delta":"tok"}\n\n');
    expect(substituter.push(event).byteLength).toBe(event.byteLength);
    expect((substituter as unknown as { pending: Buffer }).pending.byteLength).toBe(0);
  });

  test('five events arrive as five emissions, not one', () => {
    const substituter = new StreamSubstituter(pairs);
    const emissions: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      emissions.push(substituter.push(Buffer.from(`data: {"i":${i}}\n\n`)).byteLength);
    }
    expect(emissions.every((n) => n > 0)).toBe(true);
    // And the last one needed no flush() to escape.
    expect(substituter.flush().byteLength).toBe(0);
  });

  test('a 2208-byte PEM needle still does not withhold ordinary bytes', () => {
    // The pathological profile: window 2208 collapsed all five events into one
    // emission at end-of-stream. Needle length must not gate promptness.
    const pem = `-----BEGIN RSA PRIVATE KEY-----\n${'MIIEow'.repeat(300)}\n-----END RSA PRIVATE KEY-----`;
    const substituter = new StreamSubstituter([pair(pem, '[REDACTED]', 'PEM')]);
    const event = Buffer.from('data: {"delta":"tok"}\n\n');
    expect(substituter.push(event).byteLength).toBe(event.byteLength);
  });
});

describe('retention still happens exactly when it matters', () => {
  const pairs = [pair(HANDLE, VALUE, 'PRIMARY')];

  test('a chunk ending in a needle PREFIX emits less than it was given', () => {
    // The adversarial counterpart of the promptness tests, and the leak a naive
    // "just flush everything" fix causes: emitting these bytes now ships the
    // first 11 bytes of the handle to the upstream un-substituted, and the
    // remainder arrives next and no longer matches.
    const substituter = new StreamSubstituter(pairs);
    const chunk = Buffer.from(`noise${HANDLE.slice(0, 11)}`);
    const emitted = substituter.push(chunk);
    expect(emitted.byteLength).toBeLessThan(chunk.byteLength);
    expect(emitted.toString()).toBe('noise');
    // Feeding the rest completes the match — no split secret reaches the wire.
    const rest = Buffer.concat([substituter.push(Buffer.from(HANDLE.slice(11))), substituter.flush()]);
    expect(Buffer.concat([emitted, rest]).toString()).toBe(`noise${VALUE}`);
  });

  test('retention never exceeds the longest needle minus one', () => {
    // The memory bound that removes the size caps, asserted against the worst
    // case: a chunk that IS a maximal proper prefix.
    const substituter = new StreamSubstituter(pairs);
    substituter.push(Buffer.from(HANDLE.slice(0, HANDLE.length - 1)));
    expect((substituter as unknown as { pending: Buffer }).pending.byteLength).toBe(HANDLE.length - 1);
  });

  test('dispose() zero-fills the needle and replacement bytes', () => {
    // A long-lived SSE/WS relay holds decrypted secret values for the life of
    // the connection, not milliseconds. Zeroing on teardown bounds that window.
    const needle = Buffer.from(HANDLE);
    const replacement = Buffer.from(VALUE);
    const substituter = new StreamSubstituter([{ needle, replacement, label: 'PRIMARY' }]);
    substituter.push(Buffer.from('x'));
    substituter.flush();
    substituter.dispose();
    expect(needle.every((byte) => byte === 0)).toBe(true);
    expect(replacement.every((byte) => byte === 0)).toBe(true);
  });
});

describe('the streaming result is byte-identical to the whole-buffer oracle', () => {
  const pairs = [pair(HANDLE, VALUE, 'A'), pair('SECOND_NEEDLE_XyZ', 'second-value', 'B')];

  test('fuzz: random bodies × random chunkings agree with the oracle', () => {
    // "It works at my chunk size" is the bug class this file exists to prevent,
    // so correctness is asserted against the non-streaming implementation for
    // many shapes rather than a few hand-picked ones.
    const alphabet = 'ab \n{}"kortix_KXS1';
    // Deterministic PRNG: a fuzz that cannot be replayed is not a fuzz.
    let seed = 0x2f6e2b1;
    const rand = (n: number) => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed % n;
    };
    for (let round = 0; round < 300; round += 1) {
      let body = '';
      const length = rand(400);
      for (let i = 0; i < length; i += 1) {
        // Sprinkle real needles in, so matches actually happen.
        if (rand(20) === 0) body += HANDLE;
        else if (rand(40) === 0) body += 'SECOND_NEEDLE_XyZ';
        else body += alphabet[rand(alphabet.length)];
      }
      const expected = substituteWholeBuffer(Buffer.from(body), pairs).toString('utf8');
      const chunkSize = 1 + rand(64);
      expect(stream(body, pairs, chunkSize)).toBe(expected);
    }
  });

  test('binary-safe: works on bytes that are not valid UTF-8', () => {
    const needle = Buffer.from([0x00, 0xff, 0xfe, 0x01]);
    const replacement = Buffer.from([0x42, 0x42]);
    const source = Buffer.concat([Buffer.from([0x10, 0x00, 0xff]), needle, Buffer.from([0x99])]);
    const substituter = new StreamSubstituter([{ needle, replacement }]);
    const out: Buffer[] = [];
    for (const byte of source) out.push(substituter.push(Buffer.from([byte])));
    out.push(substituter.flush());
    expect(Buffer.concat(out)).toEqual(
      Buffer.concat([Buffer.from([0x10, 0x00, 0xff]), replacement, Buffer.from([0x99])]),
    );
  });
});
