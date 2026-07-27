/**
 * Unit tests for THE RULE: an agent principal may not push a protected ref.
 *
 * This is the server-side enforcement of R-9.6 — "work reaches the default
 * branch ONLY through a change request". Until now that lived only in an
 * agent's prompt, and a model that ignores its prompt (or is talked out of it
 * by goal text a user wrote) could push straight to the company repo's default
 * branch.
 *
 * The bytes exercised here are REAL captures from git 2.39.1, so the rule is
 * pinned against the wire format a client actually sends, not an idealized one.
 */
import { describe, expect, test } from 'bun:test';
import {
  buildProtectedRefRejection,
  decideReceivePack,
  parseReceivePackCommands,
  PROTECTED_REF_REASON,
} from '../git-proxy/receive-pack';
import { protectedRefsFor } from '../git-proxy/principal';

const bytes = (s: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(s, (ch) => ch.charCodeAt(0) & 0xff);
const PROTECTED = protectedRefsFor({ projectDefaultBranch: 'main' });

const CAPTURED_PUSH_MAIN =
  '00af02b015697c26889ba76e6c49c1cb80d776d7bc2a d9855296bb43281a895c313a6731cd21c5120fad refs/heads/main\u0000 report-status-v2 side-band-64k quiet object-format=sha1 agent=git/2.39.10000';

const CAPTURED_PUSH_MAIN_AND_FEATURE =
  '00af02b015697c26889ba76e6c49c1cb80d776d7bc2a d9855296bb43281a895c313a6731cd21c5120fad refs/heads/main\u0000 report-status-v2 side-band-64k quiet object-format=sha1 agent=git/2.39.100670000000000000000000000000000000000000000 d9855296bb43281a895c313a6731cd21c5120fad refs/heads/feat-a00670000000000000000000000000000000000000000 02b015697c26889ba76e6c49c1cb80d776d7bc2a refs/heads/feat-b0000';

const CAPTURED_SESSION_BRANCH =
  '0035shallow 02b015697c26889ba76e6c49c1cb80d776d7bc2a\n00cf0000000000000000000000000000000000000000 3699610caaad37a71b3dc48e5fd4cf7b18f9a1c0 refs/heads/3f2a1b7c-9d4e-4a1b-8c2d-1e5f7a9b3c4d\u0000 report-status-v2 side-band-64k quiet object-format=sha1 agent=git/2.39.10000';

const CAPTURED_DELETE_MAIN =
  '00af02b015697c26889ba76e6c49c1cb80d776d7bc2a 0000000000000000000000000000000000000000 refs/heads/main\u0000 report-status-v2 side-band-64k quiet object-format=sha1 agent=git/2.39.10000';

const decide = (
  principalClass: 'agent' | 'human',
  body: string,
  protectedRefs: readonly string[] = PROTECTED,
) =>
  decideReceivePack({
    principalClass,
    protectedRefs,
    parsed: parseReceivePackCommands(bytes(body)),
  });

describe('the rule — agent principals', () => {
  test('agent pushing the default branch is DENIED', () => {
    const decision = decide('agent', CAPTURED_PUSH_MAIN);
    expect(decision.action).toBe('deny');
    if (decision.action !== 'deny' || decision.reason !== 'protected-ref') throw new Error('shape');
    expect(decision.matchedRefs).toEqual(['refs/heads/main']);
  });

  test('agent pushing a session-UUID branch from a depth-1 clone PASSES', () => {
    // The hot path: every sandbox session push looks exactly like this. If it
    // ever denies, we have broken agent work everywhere.
    expect(decide('agent', CAPTURED_SESSION_BRANCH)).toEqual({
      action: 'allow',
      reason: 'no-protected-ref',
    });
  });

  test('agent pushing an `agi/<topic>` branch PASSES — the intended path stays open', () => {
    const command = `${'0'.repeat(40)} ${'a'.repeat(40)} refs/heads/agi/tighten-git-proxy`;
    const len = (command.length + 4).toString(16).padStart(4, '0');
    expect(decide('agent', `${len}${command}0000`)).toEqual({
      action: 'allow',
      reason: 'no-protected-ref',
    });
  });

  test('THE BYPASS: `git push origin feature main` denies the WHOLE push', () => {
    // git applies a multi-ref push as ONE request. A per-ref filter that let
    // the siblings through would still land `main`. And because we never
    // forward the request, no sibling is applied either — so every command must
    // report `ng`, never `ok`.
    const decision = decide('agent', CAPTURED_PUSH_MAIN_AND_FEATURE);
    if (decision.action !== 'deny' || decision.reason !== 'protected-ref') throw new Error('shape');
    expect(decision.matchedRefs).toEqual(['refs/heads/main']);
    expect(decision.commands.map((c) => c.ref)).toEqual([
      'refs/heads/main',
      'refs/heads/feat-a',
      'refs/heads/feat-b',
    ]);
  });

  test('DELETING the default branch is denied — a delete is still a ref update', () => {
    const decision = decide('agent', CAPTURED_DELETE_MAIN);
    if (decision.action !== 'deny' || decision.reason !== 'protected-ref') throw new Error('shape');
    expect(decision.commands[0]!.isDelete).toBe(true);
    expect(decision.matchedRefs).toEqual(['refs/heads/main']);
  });

  test('FORCE-pushing the default branch is denied', () => {
    // A force push is wire-identical to any other update — the proxy cannot
    // even tell, which is precisely why the rule is "any update to this ref".
    const command = `${'9'.repeat(40)} ${'a'.repeat(40)} refs/heads/main`;
    const len = (command.length + 4).toString(16).padStart(4, '0');
    const decision = decide('agent', `${len}${command}0000`);
    expect(decision.action).toBe('deny');
  });

  test('the STALE connection default_branch is protected too', () => {
    // PATCH /v1/projects/:id moves only `projects.default_branch`; the union
    // closes the drift bypass.
    const decision = decide(
      'agent',
      CAPTURED_PUSH_MAIN,
      protectedRefsFor({ projectDefaultBranch: 'trunk', connectionDefaultBranch: 'main' }),
    );
    expect(decision.action).toBe('deny');
  });

  test('exact byte comparison: `refs/heads/Main` is not `refs/heads/main`', () => {
    const command = `${'0'.repeat(40)} ${'a'.repeat(40)} refs/heads/Main`;
    const len = (command.length + 4).toString(16).padStart(4, '0');
    expect(decide('agent', `${len}${command}0000`).action).toBe('allow');
  });
});

describe('the rule — failure mode (unparseable ⇒ deny, agents only)', () => {
  // Failing OPEN would cost the entire control: an agent with a shell can gzip
  // the body, set push.gpgSign, or use another git implementation to make the
  // head unreadable. A control you can switch off by compressing your request
  // is not a control. Failing CLOSED cannot break a human push, because human
  // principals are never parsed at all.
  const unparseable: Array<[string, string]> = [
    ['garbage length prefix', 'zzzzgarbage'],
    ['truncated command list', '00af02b015697c26'],
    ['flush with no commands', '0000'],
  ];

  for (const [name, body] of unparseable) {
    test(`agent + ${name} ⇒ deny`, () => {
      const decision = decide('agent', body);
      expect(decision.action).toBe('deny');
      if (decision.action !== 'deny') return;
      expect(decision.reason).toBe('unparseable');
    });
  }

  test('a signed push (push-cert) denies with its own distinct reason code', () => {
    const line = 'push-cert\u0000 report-status side-band-64k';
    const len = (line.length + 4).toString(16).padStart(4, '0');
    const decision = decide('agent', `${len}${line}`);
    if (decision.action !== 'deny' || decision.reason !== 'unparseable') throw new Error('shape');
    // Distinct detail codes keep "we broke pushes" and "we blocked an attack"
    // from ever being the same line on a dashboard.
    expect(decision.detail).toBe('push-cert');
  });

  test('a body we refuse to decode (content-encoding) denies', () => {
    expect(
      decideReceivePack({
        principalClass: 'agent',
        protectedRefs: PROTECTED,
        parsed: { ok: false, reason: 'content-encoding' },
      }),
    ).toEqual({ action: 'deny', reason: 'unparseable', detail: 'content-encoding' });
  });
});

describe('the rule — human principals are untouched', () => {
  test('human pushing the default branch PASSES', () => {
    expect(decide('human', CAPTURED_PUSH_MAIN)).toEqual({ action: 'allow', reason: 'not-agent' });
  });

  test('human + a body that would be unparseable still PASSES', () => {
    // Proof that the parse is never consulted for a human: `kortix ship` from a
    // laptop and an ordinary `git push` gain zero new failure modes.
    expect(decide('human', 'zzzz-total-garbage')).toEqual({
      action: 'allow',
      reason: 'not-agent',
    });
  });

  test('human + multi-ref push including the default branch PASSES', () => {
    expect(decide('human', CAPTURED_PUSH_MAIN_AND_FEATURE)).toEqual({
      action: 'allow',
      reason: 'not-agent',
    });
  });
});

describe('the rejection carries a usable instruction', () => {
  test('the protected ref is told to open a change request', () => {
    const decision = decide('agent', CAPTURED_PUSH_MAIN);
    if (decision.action !== 'deny' || decision.reason !== 'protected-ref') throw new Error('shape');
    const report = Buffer.from(buildProtectedRefRejection(decision)).toString('latin1');
    expect(report).toContain('kortix cr open --head');
    expect(PROTECTED_REF_REASON).toContain('kortix cr open --head');
  });
});
