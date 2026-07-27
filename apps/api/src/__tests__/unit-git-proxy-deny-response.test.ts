/**
 * Unit tests for the DENIAL BYTES.
 *
 * A denial is only useful if the caller can act on it. An HTTP 403 is not:
 * measured against a real git client, a 403 prints only
 *   "error: RPC failed; HTTP 403" / "the remote end hung up unexpectedly"
 * and the body is never displayed — so an agent trying to self-correct never
 * learns to open a change request. We answer HTTP 200 with a git-native
 * `report-status` document instead, which a real `git push` renders as:
 *
 *   remote: Kortix: this push was refused by the git proxy.
 *    ! [remote rejected] main -> main (protected: agents land work through a …)
 *   error: failed to push some refs to '…'
 *
 * with exit code 1. These tests pin the framing that makes that render work;
 * getting it wrong yields "protocol error: bad band #117" and a hung push.
 */
import { describe, expect, test } from 'bun:test';
import {
  buildRejectionReport,
  buildProtectedRefRejection,
  DENIAL_PREAMBLE,
  PROTECTED_REF_REASON,
  sanitizeReason,
  siblingRefReason,
  type ReceivePackCommand,
} from '../git-proxy/receive-pack';

const text = (b: Uint8Array) => Buffer.from(b).toString('latin1');

const command = (ref: string, over: Partial<ReceivePackCommand> = {}): ReceivePackCommand => ({
  oldOid: '0'.repeat(40),
  newOid: 'a'.repeat(40),
  ref,
  isDelete: false,
  ...over,
});

describe('report framing', () => {
  test('without side-band-64k the report is emitted RAW', () => {
    // Emitting a band marker to a client that did not negotiate sideband makes
    // git read the first byte of "unpack ok" as a band number and abort with
    // "protocol error: bad band #117".
    const out = text(
      buildRejectionReport({
        commands: [command('refs/heads/main')],
        caps: ['report-status'],
        reasonFor: () => 'nope',
      }),
    );
    expect(out.startsWith('000eunpack ok\n')).toBe(true);
    expect(out.endsWith('0000')).toBe(true);
    expect(out).not.toContain(DENIAL_PREAMBLE);
  });

  test('with side-band-64k the report is wrapped in bands 2 and 1', () => {
    const out = text(
      buildRejectionReport({
        commands: [command('refs/heads/main')],
        caps: ['report-status-v2', 'side-band-64k'],
        reasonFor: () => 'nope',
      }),
    );
    // Band 2 = progress/stderr — this is what surfaces as `remote: …`.
    expect(out).toContain(`${DENIAL_PREAMBLE}`);
    // Band 1 = the packet stream the client parses as report-status.
    expect(out).toContain('000eunpack ok\n');
    expect(out.endsWith('0000')).toBe(true);
  });

  test('every command gets an `ng`; none is ever reported `ok`', () => {
    // We never forwarded the request, so we cannot honestly claim any ref
    // landed — reporting `ok` for a sibling would be a lie git acts on.
    const out = text(
      buildRejectionReport({
        commands: [command('refs/heads/main'), command('refs/heads/feat-a')],
        caps: [],
        reasonFor: () => 'nope',
      }),
    );
    expect(out).toContain('ng refs/heads/main nope\n');
    expect(out).toContain('ng refs/heads/feat-a nope\n');
    expect(out).not.toContain('\nok ');
  });
});

describe('buildProtectedRefRejection — what the caller is told', () => {
  const decision = {
    matchedRefs: ['refs/heads/main'],
    caps: ['report-status-v2', 'side-band-64k'],
    commands: [command('refs/heads/main'), command('refs/heads/feat-a')],
  };

  test('the protected ref carries the change-request instruction', () => {
    const out = text(buildProtectedRefRejection(decision));
    expect(out).toContain(`ng refs/heads/main ${PROTECTED_REF_REASON}`);
    expect(out).toContain('kortix cr open --head');
  });

  test('siblings in the same push are told WHY they were not attempted', () => {
    const out = text(buildProtectedRefRejection(decision));
    expect(out).toContain(
      `ng refs/heads/feat-a ${siblingRefReason('refs/heads/main')}`,
    );
    expect(siblingRefReason('refs/heads/main')).toContain('not attempted');
  });

  test('a delete-only denial still produces a well-formed report', () => {
    const out = text(
      buildProtectedRefRejection({
        matchedRefs: ['refs/heads/main'],
        caps: [],
        commands: [command('refs/heads/main', { newOid: '0'.repeat(40), isDelete: true })],
      }),
    );
    expect(out.startsWith('000eunpack ok\n')).toBe(true);
    expect(out).toContain('ng refs/heads/main protected:');
  });
});

describe('reason strings are pkt-line safe', () => {
  test('the canned reasons contain no newline', () => {
    // A reason sits INSIDE a pkt-line; an embedded newline would desynchronise
    // the client's parser mid-report.
    for (const reason of [PROTECTED_REF_REASON, siblingRefReason('refs/heads/main')]) {
      expect(reason).not.toContain('\n');
      expect(reason).not.toContain('\r');
      expect(reason.length).toBeLessThanOrEqual(200);
    }
  });

  test('sanitizeReason strips control characters and caps the length', () => {
    expect(sanitizeReason('line one\nline two\r\nthree')).toBe('line one line two three');
    expect(sanitizeReason('x'.repeat(500)).length).toBe(200);
  });

  test('a hostile ref name cannot inject extra report lines', () => {
    // Ref names come off the wire. The parser already rejects spaces, and the
    // reason is sanitized — together they keep an attacker from forging an
    // `ok` line inside our own report.
    const out = text(
      buildRejectionReport({
        commands: [command('refs/heads/x')],
        caps: [],
        reasonFor: () => 'bad\nok refs/heads/main',
      }),
    );
    expect(out).not.toContain('\nok refs/heads/main');
    expect(out).toContain('ng refs/heads/x bad ok refs/heads/main\n');
  });
});

describe('pkt-line length prefixes are correct', () => {
  test('each emitted pkt-line declares its own true length', () => {
    // A wrong length prefix silently corrupts everything after it.
    const out = text(
      buildRejectionReport({
        commands: [command('refs/heads/main'), command('refs/heads/feat-a')],
        caps: [],
        reasonFor: () => 'r',
      }),
    );
    let at = 0;
    const seen: string[] = [];
    while (at < out.length) {
      const len = Number.parseInt(out.slice(at, at + 4), 16);
      if (len === 0) {
        at += 4;
        continue;
      }
      expect(len).toBeGreaterThanOrEqual(4);
      expect(at + len).toBeLessThanOrEqual(out.length);
      seen.push(out.slice(at + 4, at + len));
      at += len;
    }
    expect(seen).toEqual(['unpack ok\n', 'ng refs/heads/main r\n', 'ng refs/heads/feat-a r\n']);
  });
});
