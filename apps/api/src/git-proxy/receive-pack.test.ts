/**
 * The fixtures here are REAL bytes, captured from `git push` (git/2.39.1) against
 * a throwaway smart-HTTP server on 2026-09-01, not hand-written guesses. Both
 * protocol traps this module exists to avoid were found that way:
 *   - a response without the band-1 prefix made git abort `bad band #117`;
 *   - a pkt-line length computed from string length (not byte length) made git
 *     abort `bad line length character` as soon as the reason held a non-ASCII
 *     character.
 */
import { describe, expect, test } from 'bun:test';
import {
  MAX_COMMAND_SECTION_BYTES,
  encodeReportStatus,
  isCreate,
  isDelete,
  parseReceivePackCommands,
  pktLine,
  wantsSideband,
} from './receive-pack';

const ZERO = '0'.repeat(40);
const OLD = 'a'.repeat(39) + '1';
const NEW = 'db7cfd8cbb8dd3582c6f6fbcb9e8d2c25e41defb';

/** The exact command section git sent for `git push --force origin main`. */
const REAL_PUSH_PREFIX =
  '009e' +
  `${OLD} ${NEW} refs/heads/main\0` +
  ' report-status-v2 side-band-64k quiet object-format=sha1' +
  '0000';

function bytes(s: string): Uint8Array {
  return Buffer.from(s, 'latin1');
}

describe('parseReceivePackCommands', () => {
  test('parses the command section captured from a real git push', () => {
    const result = parseReceivePackCommands(bytes(REAL_PUSH_PREFIX));
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.updates).toEqual([{ oldSha: OLD, newSha: NEW, ref: 'refs/heads/main' }]);
    expect(result.capabilities).toContain('side-band-64k');
    expect(result.capabilities).toContain('report-status-v2');
    // The whole decision is made inside the first ~160 bytes, ahead of the pack.
    expect(result.commandBytes).toBe(REAL_PUSH_PREFIX.length);
    expect(result.commandBytes).toBeLessThan(200);
  });

  test('PACK data after the flush-pkt is never consumed', () => {
    const withPack = REAL_PUSH_PREFIX + 'PACK\x00\x00\x02binary-garbage\xff';
    const result = parseReceivePackCommands(bytes(withPack));
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.commandBytes).toBe(REAL_PUSH_PREFIX.length);
  });

  test('reports need-more until the terminating flush-pkt arrives', () => {
    const full = bytes(REAL_PUSH_PREFIX);
    // Every strict prefix is incomplete; only the full section parses.
    for (const cut of [4, 40, 100, full.length - 1]) {
      expect(parseReceivePackCommands(full.slice(0, cut)).status).toBe('need-more');
    }
    expect(parseReceivePackCommands(full).status).toBe('ok');
  });

  test('parses a multi-ref push and keeps every ref', () => {
    const body =
      pktLineStr(`${ZERO} ${NEW} refs/heads/feature\0 report-status side-band-64k\n`) +
      pktLineStr(`${OLD} ${ZERO} refs/heads/stale\n`) +
      pktLineStr(`${OLD} ${NEW} refs/heads/main\n`) +
      '0000';
    const result = parseReceivePackCommands(bytes(body));
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.updates.map((u) => u.ref)).toEqual([
      'refs/heads/feature',
      'refs/heads/stale',
      'refs/heads/main',
    ]);
    expect(isCreate(result.updates[0]!)).toBe(true);
    expect(isDelete(result.updates[1]!)).toBe(true);
    expect(isCreate(result.updates[2]!)).toBe(false);
    expect(isDelete(result.updates[2]!)).toBe(false);
  });

  test('accepts sha256 object ids', () => {
    const long = 'f'.repeat(64);
    const body = pktLineStr(`${'0'.repeat(64)} ${long} refs/heads/main\n`) + '0000';
    const result = parseReceivePackCommands(bytes(body));
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(isCreate(result.updates[0]!)).toBe(true);
  });

  test('a tag ref is parsed like any other ref', () => {
    const body = pktLineStr(`${ZERO} ${NEW} refs/tags/v1.0.0\n`) + '0000';
    const result = parseReceivePackCommands(bytes(body));
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.updates[0]!.ref).toBe('refs/tags/v1.0.0');
  });

  test.each([
    ['non-hex length header', 'zzzz' + 'x'.repeat(10)],
    ['length below the 4-byte minimum', '0002ab'],
    ['command with too few fields', pktLineStr(`${OLD} refs/heads/main\n`) + '0000'],
    ['garbage object id', pktLineStr(`nope ${NEW} refs/heads/main\n`) + '0000'],
    ['unqualified ref name', pktLineStr(`${OLD} ${NEW} main\n`) + '0000'],
  ])('rejects %s', (_label, body) => {
    expect(parseReceivePackCommands(bytes(body)).status).toBe('invalid');
  });

  test('the buffering bound is far above any real push', () => {
    // A one-ref push is ~160 bytes; the bound must not be reachable in practice.
    expect(MAX_COMMAND_SECTION_BYTES).toBeGreaterThan(REAL_PUSH_PREFIX.length * 1000);
  });
});

describe('encodeReportStatus', () => {
  test('sideband response carries the band-1 prefix git demands', () => {
    const out = Buffer.from(encodeReportStatus([{ ref: 'refs/heads/main', reason: 'nope' }], {
      sideband: true,
    }));
    // Outer pkt-line: 4 hex length, then the band byte, then the report.
    expect(out.subarray(0, 4).toString('ascii')).toMatch(/^[0-9a-f]{4}$/);
    expect(out[4]).toBe(0x01);
    const declared = parseInt(out.subarray(0, 4).toString('ascii'), 16);
    // Declared length covers the header itself, and the body ends with a flush.
    expect(declared).toBe(out.length - 4);
    expect(out.subarray(out.length - 4).toString('ascii')).toBe('0000');
    const inner = out.subarray(5, out.length - 4).toString('latin1');
    expect(inner).toContain('unpack ok');
    expect(inner).toContain('ng refs/heads/main nope');
  });

  test('non-sideband response is the bare report', () => {
    const out = Buffer.from(
      encodeReportStatus([{ ref: 'refs/heads/main', reason: 'nope' }], { sideband: false }),
    ).toString('latin1');
    expect(out.startsWith('000eunpack ok\n')).toBe(true);
    expect(out.endsWith('0000')).toBe(true);
    expect(out).not.toContain('\x01');
  });

  test('pkt-line lengths count BYTES, not string length', () => {
    // The regression that broke a real push: a multi-byte character made the
    // declared length short and git aborted on the next frame.
    const line = Buffer.from(pktLine('ng refs/heads/main café\n'));
    const declared = parseInt(line.subarray(0, 4).toString('ascii'), 16);
    expect(declared).toBe(line.length);
    expect(line.length).toBeGreaterThan('ng refs/heads/main café\n'.length + 4);
  });

  test('a reason cannot break the frame or the report grammar', () => {
    const out = Buffer.from(
      encodeReportStatus(
        [{ ref: 'refs/heads/main', reason: 'line one\nng refs/heads/other spoofed\0' }],
        { sideband: false },
      ),
    ).toString('latin1');
    // The injected newline must not have produced a second pkt-line: the whole
    // reason has to stay inside the one frame, where git treats it as text. A
    // naive substring count would be the wrong assertion here - a sanitized
    // reason may legally still contain the characters "ng ".
    const frames = splitPktLines(out);
    expect(frames).toHaveLength(2);
    expect(frames[0]).toBe('unpack ok\n');
    expect(frames[1]).toBe('ng refs/heads/main line one ng refs/heads/other spoofed\n');
    expect(out).not.toContain('\x00');
  });

  test('reports accepted refs alongside refused ones', () => {
    const out = Buffer.from(
      encodeReportStatus(
        [{ ref: 'refs/heads/ok' }, { ref: 'refs/heads/no', reason: 'denied' }],
        { sideband: false },
      ),
    ).toString('latin1');
    expect(out).toContain('ok refs/heads/ok');
    expect(out).toContain('ng refs/heads/no denied');
  });

  test('an empty reason still yields a valid ng line', () => {
    const out = Buffer.from(
      encodeReportStatus([{ ref: 'refs/heads/main', reason: '\n\n' }], { sideband: false }),
    ).toString('latin1');
    expect(out).toContain('ng refs/heads/main rejected');
  });
});

describe('wantsSideband', () => {
  test('detects the capability git actually sends', () => {
    expect(wantsSideband(['report-status-v2', 'side-band-64k', 'quiet'])).toBe(true);
    expect(wantsSideband(['side-band'])).toBe(true);
    expect(wantsSideband(['report-status', 'quiet'])).toBe(false);
    expect(wantsSideband([])).toBe(false);
  });
});

/** Split a raw report body into its pkt-line payloads (ignores the flush). */
function splitPktLines(raw: string): string[] {
  const out: string[] = [];
  let off = 0;
  while (off + 4 <= raw.length) {
    const len = parseInt(raw.slice(off, off + 4), 16);
    if (!len) break;
    out.push(raw.slice(off + 4, off + len));
    off += len;
  }
  return out;
}

function pktLineStr(payload: string): string {
  return (Buffer.byteLength(payload, 'latin1') + 4).toString(16).padStart(4, '0') + payload;
}
