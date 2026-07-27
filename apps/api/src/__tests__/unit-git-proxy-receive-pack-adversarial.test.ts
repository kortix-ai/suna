/**
 * ADVERSARIAL suite for the R-9.6 git-proxy control (receive-pack.ts).
 *
 * Written by a reviewer trying to BREAK the control, not to demonstrate it.
 * Every case here is an attempt to land a command on the protected ref while
 * the parser says "allow", or to make a legitimate push say "deny".
 *
 * Cases that ALLOW are documented residuals, not accidents — each carries the
 * reason the residual is (or is not) exploitable end-to-end.
 */
import { describe, expect, test } from 'bun:test';
import {
  decideReceivePack,
  parseReceivePackCommands,
  peekReceivePackHead,
  type ReceivePackDecision,
} from '../git-proxy/receive-pack';
import { classifyGitPrincipal, protectedRefsFor } from '../git-proxy/principal';

const enc = new TextEncoder();
const OID_A = 'a'.repeat(40);
const OID_B = 'b'.repeat(40);
const ZERO = '0'.repeat(40);

function pkt(payload: string): string {
  const bytes = enc.encode(payload);
  return (bytes.length + 4).toString(16).padStart(4, '0') + payload;
}

/** Build a receive-pack head. `lines` are raw pkt-line payloads. */
function body(...lines: string[]): Uint8Array {
  return enc.encode(lines.map(pkt).join('') + '0000');
}

function cmd(oldOid: string, newOid: string, ref: string, caps?: string): string {
  return `${oldOid} ${newOid} ${ref}${caps ? `\0${caps}` : ''}\n`;
}

const PROTECTED = protectedRefsFor({ projectDefaultBranch: 'main', connectionDefaultBranch: 'main' });

function decide(head: Uint8Array): ReceivePackDecision {
  return decideReceivePack({
    principalClass: 'agent',
    protectedRefs: PROTECTED,
    parsed: parseReceivePackCommands(head),
  });
}

describe('attack 1 — multi-ref push (does the check inspect ALL commands?)', () => {
  test('main SECOND, behind a feature ref, is caught', () => {
    const d = decide(
      body(
        cmd(ZERO, OID_A, 'refs/heads/feature', 'report-status side-band-64k'),
        cmd(OID_A, OID_B, 'refs/heads/main'),
      ),
    );
    expect(d.action).toBe('deny');
    expect(d.reason).toBe('protected-ref');
  });

  test('main LAST of fifty is caught', () => {
    const lines = Array.from({ length: 49 }, (_, i) =>
      cmd(ZERO, OID_A, `refs/heads/f${i}`, i === 0 ? 'report-status' : undefined),
    );
    lines.push(cmd(OID_A, OID_B, 'refs/heads/main'));
    const d = decide(body(...lines));
    expect(d.action).toBe('deny');
  });

  test('a push with NO protected ref is still allowed after a multi-ref parse', () => {
    const d = decide(
      body(
        cmd(ZERO, OID_A, 'refs/heads/feature', 'report-status'),
        cmd(ZERO, OID_B, 'refs/heads/other'),
      ),
    );
    expect(d.action).toBe('allow');
  });
});

describe('attack 2 — ref-name tricks', () => {
  test('DENIED: delete of main (all-zero new oid)', () => {
    expect(decide(body(cmd(OID_A, ZERO, 'refs/heads/main', 'report-status'))).action).toBe('deny');
  });

  test('DENIED: trailing space after the ref (parses as malformed, fails closed)', () => {
    const d = decide(body(cmd(ZERO, OID_A, 'refs/heads/main ')));
    expect(d.action).toBe('deny');
  });

  test('DENIED: NUL-truncation matches git — caps after NUL are not part of the ref', () => {
    // git computes refname = strlen(p), i.e. it stops at the NUL on EVERY
    // command line, not just the first. So `refs/heads/main\0<caps>` is a push
    // to main for git too, and must be denied.
    expect(decide(body(cmd(ZERO, OID_A, 'refs/heads/main', 'report-status'))).action).toBe('deny');
  });

  test('RESIDUAL: a differently-cased branch is ALLOWED (refs/heads/Main)', () => {
    // Not a bypass on GitHub (ref names are byte-compared, so this creates a
    // NEW branch). It WOULD be one on any upstream storing loose refs on a
    // case-insensitive filesystem, where refs/heads/Main and refs/heads/main
    // are the same file.
    expect(decide(body(cmd(ZERO, OID_A, 'refs/heads/Main'))).action).toBe('allow');
  });

  test('RESIDUAL: refs/heads/./main is ALLOWED by the proxy', () => {
    // The proxy forwards it; safety here rests entirely on the UPSTREAM's
    // check_refname_format rejecting a "." path component. Kortix does not
    // validate ref names itself.
    expect(decide(body(cmd(ZERO, OID_A, 'refs/heads/./main'))).action).toBe('allow');
  });

  test('RESIDUAL: a trailing CR is ALLOWED by the proxy', () => {
    // Same as above: only one trailing LF is stripped, so `main\r` is a
    // different ref to the proxy. git rejects control characters in refnames,
    // so this dies upstream — but the proxy is not what stops it.
    expect(decide(body(cmd(ZERO, OID_A, 'refs/heads/main\r'))).action).toBe('allow');
  });

  test('unqualified `main` is allowed — but is not the default branch upstream', () => {
    expect(decide(body(cmd(ZERO, OID_A, 'main'))).action).toBe('allow');
  });
});

describe('attack 3 — pkt-line parsing (can a crafted body fail OPEN?)', () => {
  const shapes: Array<[string, Uint8Array]> = [
    ['truncated length prefix', enc.encode('00')],
    ['non-hex length prefix', enc.encode('zzzz' + cmd(ZERO, OID_A, 'refs/heads/main'))],
    ['delim-pkt (0001) in command position', enc.encode('0001' + '0000')],
    ['response-end pkt (0002)', enc.encode('0002' + '0000')],
    ['length longer than the body', enc.encode('00ff' + cmd(ZERO, OID_A, 'refs/heads/main'))],
    ['flush with zero commands', enc.encode('0000')],
    ['empty pkt (0004)', enc.encode('0004' + '0000')],
    ['push-cert first', body('push-cert\n', cmd(ZERO, OID_A, 'refs/heads/main'))],
    ['push-cert AFTER a benign command', body(cmd(ZERO, OID_A, 'refs/heads/f'), 'push-cert\n')],
    ['two commands crammed into one pkt-line', body(`${ZERO} ${OID_A} refs/heads/f\n${ZERO} ${OID_A} refs/heads/main\n`)],
    ['shallow line with a junk oid', body('shallow nothex\n', cmd(ZERO, OID_A, 'refs/heads/f'))],
    ['shallow AFTER the first command', body(cmd(ZERO, OID_A, 'refs/heads/f'), 'shallow ' + OID_A + '\n')],
    ['no flush-pkt at all', enc.encode(pkt(cmd(ZERO, OID_A, 'refs/heads/f')))],
    ['garbage', enc.encode('PACK\0\0\0\0')],
  ];

  for (const [name, bytes] of shapes) {
    test(`DENIED for an agent: ${name}`, () => {
      const d = decide(bytes);
      expect(d.action).toBe('deny');
    });

    test(`untouched for a human: ${name}`, () => {
      const d = decideReceivePack({
        principalClass: 'human',
        protectedRefs: PROTECTED,
        parsed: parseReceivePackCommands(bytes),
      });
      expect(d).toEqual({ action: 'allow', reason: 'not-agent' });
    });
  }

  test('a byte-at-a-time trickle of a main push is still caught', async () => {
    const bytes = body(cmd(ZERO, OID_A, 'refs/heads/main', 'report-status side-band-64k'));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const b of bytes) controller.enqueue(new Uint8Array([b]));
        controller.close();
      },
    });
    const peek = await peekReceivePackHead(stream.getReader());
    const d = decideReceivePack({ principalClass: 'agent', protectedRefs: PROTECTED, parsed: peek.parsed });
    expect(d.action).toBe('deny');
    expect(d.reason).toBe('protected-ref');
  });

  test('a body that stops mid-command-list denies rather than allowing', async () => {
    const full = body(cmd(ZERO, OID_A, 'refs/heads/main'));
    const truncated = full.subarray(0, full.length - 6);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(truncated);
        controller.close();
      },
    });
    const peek = await peekReceivePackHead(stream.getReader());
    expect(peek.parsed.ok).toBe(false);
    const d = decideReceivePack({ principalClass: 'agent', protectedRefs: PROTECTED, parsed: peek.parsed });
    expect(d.action).toBe('deny');
  });
});

describe('attack 6 — default-branch drift / empty protected set', () => {
  test('BYPASS: an empty protected set allows an agent push to any ref', () => {
    const d = decideReceivePack({
      principalClass: 'agent',
      protectedRefs: protectedRefsFor({ projectDefaultBranch: '', connectionDefaultBranch: null }),
      parsed: parseReceivePackCommands(body(cmd(OID_A, OID_B, 'refs/heads/main'))),
    });
    expect(d.action).toBe('allow');
  });

  test('BYPASS: DB default_branch that disagrees with the real upstream HEAD', () => {
    // projects.default_branch is a cached copy written at registration. Rename
    // the branch on GitHub (or import a repo whose default is `master`) and the
    // protected set names a branch that is no longer the default.
    const d = decideReceivePack({
      principalClass: 'agent',
      protectedRefs: protectedRefsFor({ projectDefaultBranch: 'main', connectionDefaultBranch: 'main' }),
      parsed: parseReceivePackCommands(body(cmd(OID_A, OID_B, 'refs/heads/master'))),
    });
    expect(d.action).toBe('allow');
  });

  test('the union of both default_branch columns is protected', () => {
    const refs = protectedRefsFor({ projectDefaultBranch: 'main', connectionDefaultBranch: 'trunk' });
    expect(refs).toEqual(['refs/heads/main', 'refs/heads/trunk']);
  });
});

describe('attack 4 — principal confusion', () => {
  test('a freshly minted project PAT (no session/grant/SA) classifies as HUMAN', () => {
    // This is the shape POST /v1/projects/:id/cli-token returns. Anything an
    // agent can do to obtain one of these is a total bypass of the control.
    expect(
      classifyGitPrincipal({ kind: 'user', accountId: 'a', userId: 'u', tokenId: 't' }),
    ).toBe('human');
  });

  test('an account API key classifies as HUMAN (documented v1 residual)', () => {
    expect(classifyGitPrincipal({ kind: 'api_key', accountId: 'a', keyId: 'k' })).toBe('human');
  });

  test('sandbox and session tokens classify as AGENT', () => {
    expect(classifyGitPrincipal({ kind: 'sandbox', sandboxId: 's', accountId: 'a' })).toBe('agent');
    expect(classifyGitPrincipal({ kind: 'session', accountId: 'a', sessionId: 's' })).toBe('agent');
  });
});
