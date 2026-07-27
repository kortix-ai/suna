/**
 * Unit tests for the git-receive-pack wire parser.
 *
 * git-receive-pack is how EVERY push in Kortix works — human `git push`,
 * `kortix ship`, the sandbox daemon's session push. Mis-parsing it breaks all
 * of them silently, so these tests run against REAL CAPTURED BYTES from
 * git 2.39.1, not hand-written approximations. Each `CAPTURED_*` constant below
 * is the verbatim prefix (everything before `PACK`) of an actual request body
 * recorded off the wire from a real `git push`.
 *
 * The case that earns its keep is CAPTURED_SHALLOW_SESSION: every Kortix
 * sandbox clones depth-1, so essentially every agent push carries leading
 * `shallow` pkt-lines BEFORE the first command. A parser that assumes pkt #1 is
 * a command classifies 100% of session pushes as unparseable — and since
 * unparseable means DENY for agents, that would break the hot path for
 * everyone.
 */
import { describe, expect, test } from 'bun:test';
import {
  MAX_COMMANDS,
  parseReceivePackCommands,
  peekReceivePackHead,
  replayReceivePackBody,
  drainRequestBody,
} from '../git-proxy/receive-pack';

/** Captured bodies are byte strings; encode 1:1, never as UTF-8. */
const bytes = (s: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(s, (ch) => ch.charCodeAt(0) & 0xff);

// ─── real captures (git 2.39.1) ──────────────────────────────────────────────

/** `git push origin main` — single ref update on the default branch. */
const CAPTURED_SINGLE_REF_MAIN =
  '00af02b015697c26889ba76e6c49c1cb80d776d7bc2a d9855296bb43281a895c313a6731cd21c5120fad refs/heads/main\u0000 report-status-v2 side-band-64k quiet object-format=sha1 agent=git/2.39.10000';

/** `git push origin main feat-a feat-b` — THE multi-ref bypass shape.
 *  Capabilities ride on the FIRST command only; the rest are bare. */
const CAPTURED_THREE_REFS =
  '00af02b015697c26889ba76e6c49c1cb80d776d7bc2a d9855296bb43281a895c313a6731cd21c5120fad refs/heads/main\u0000 report-status-v2 side-band-64k quiet object-format=sha1 agent=git/2.39.100670000000000000000000000000000000000000000 d9855296bb43281a895c313a6731cd21c5120fad refs/heads/feat-a00670000000000000000000000000000000000000000 02b015697c26889ba76e6c49c1cb80d776d7bc2a refs/heads/feat-b0000';

/** Push from a `--depth 1` clone to a session-UUID branch: a `shallow`
 *  pkt-line arrives BEFORE any command. The Kortix sandbox default. */
const CAPTURED_SHALLOW_SESSION =
  '0035shallow 02b015697c26889ba76e6c49c1cb80d776d7bc2a\n00cf0000000000000000000000000000000000000000 3699610caaad37a71b3dc48e5fd4cf7b18f9a1c0 refs/heads/3f2a1b7c-9d4e-4a1b-8c2d-1e5f7a9b3c4d\u0000 report-status-v2 side-band-64k quiet object-format=sha1 agent=git/2.39.10000';

/** `git push origin :main` — a DELETE. Zero new-oid, and no packfile at all. */
const CAPTURED_DELETE_MAIN =
  '00af02b015697c26889ba76e6c49c1cb80d776d7bc2a 0000000000000000000000000000000000000000 refs/heads/main\u0000 report-status-v2 side-band-64k quiet object-format=sha1 agent=git/2.39.10000';

const PACK = 'PACK\u0000\u0000\u0000\u0002rest-of-the-packfile';

describe('parseReceivePackCommands — real captured wire bytes', () => {
  test('single-ref push to the default branch', () => {
    const result = parseReceivePackCommands(bytes(CAPTURED_SINGLE_REF_MAIN + PACK));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.commands).toEqual([
      {
        oldOid: '02b015697c26889ba76e6c49c1cb80d776d7bc2a',
        newOid: 'd9855296bb43281a895c313a6731cd21c5120fad',
        ref: 'refs/heads/main',
        isDelete: false,
      },
    ]);
    // The capability list is what decides whether the denial must be
    // sideband-framed — parsing it wrong corrupts the rejection.
    expect(result.caps).toEqual([
      'report-status-v2',
      'side-band-64k',
      'quiet',
      'object-format=sha1',
      'agent=git/2.39.1',
    ]);
  });

  test('three refs in one push — capabilities on the first command only', () => {
    const result = parseReceivePackCommands(bytes(CAPTURED_THREE_REFS + PACK));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.commands.map((c) => c.ref)).toEqual([
      'refs/heads/main',
      'refs/heads/feat-a',
      'refs/heads/feat-b',
    ]);
    expect(result.caps).toContain('side-band-64k');
  });

  test('push from a depth-1 clone: leading `shallow` lines are skipped, not fatal', () => {
    // If this regresses, EVERY sandbox session push is classified unparseable
    // and therefore denied. This is the single highest-risk case in the parser.
    const result = parseReceivePackCommands(bytes(CAPTURED_SHALLOW_SESSION + PACK));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.commands).toHaveLength(1);
    expect(result.commands[0]!.ref).toBe('refs/heads/3f2a1b7c-9d4e-4a1b-8c2d-1e5f7a9b3c4d');
    expect(result.caps).toContain('report-status-v2');
  });

  test('delete: zero new-oid is flagged, and the body carries no packfile', () => {
    const result = parseReceivePackCommands(bytes(CAPTURED_DELETE_MAIN));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.commands[0]!.ref).toBe('refs/heads/main');
    expect(result.commands[0]!.isDelete).toBe(true);
  });
});

describe('parseReceivePackCommands — synthetic edge cases', () => {
  test('sha256 repos: 64-hex oids parse (never hard-code 40)', () => {
    const oldOid = 'a'.repeat(64);
    const newOid = 'b'.repeat(64);
    const command = `${oldOid} ${newOid} refs/heads/main\u0000 report-status object-format=sha256`;
    const len = (command.length + 4).toString(16).padStart(4, '0');
    const result = parseReceivePackCommands(bytes(`${len}${command}0000`));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.commands[0]!.oldOid).toBe(oldOid);
    expect(result.caps).toContain('object-format=sha256');
  });

  test('push-cert (`git push --signed`) is reported, not silently mis-parsed', () => {
    // Commands are nested inside push-cert…push-cert-end; the first pkt is not
    // a command. Reporting it lets the caller apply the fail-closed rule.
    const line = 'push-cert\u0000 report-status side-band-64k';
    const len = (line.length + 4).toString(16).padStart(4, '0');
    const result = parseReceivePackCommands(bytes(`${len}${line}`));
    expect(result).toEqual({ ok: false, reason: 'push-cert' });
  });

  test('truncated body: no flush-pkt yet ⇒ `incomplete` so the caller reads more', () => {
    const partial = CAPTURED_SINGLE_REF_MAIN.slice(0, 40);
    expect(parseReceivePackCommands(bytes(partial))).toEqual({ ok: false, reason: 'incomplete' });
  });

  test('non-hex length prefix ⇒ malformed-pkt', () => {
    expect(parseReceivePackCommands(bytes('zzzzgarbage'))).toEqual({
      ok: false,
      reason: 'malformed-pkt',
    });
  });

  test('protocol-v2 delim pkt (0001) is not valid in a command list', () => {
    expect(parseReceivePackCommands(bytes('0001'))).toEqual({ ok: false, reason: 'malformed-pkt' });
  });

  test('flush with zero commands ⇒ no-commands', () => {
    expect(parseReceivePackCommands(bytes('0000'))).toEqual({ ok: false, reason: 'no-commands' });
  });

  test('a pkt-line that is not `<oid> SP <oid> SP <ref>` ⇒ malformed-command', () => {
    const line = 'not-a-command-at-all';
    const len = (line.length + 4).toString(16).padStart(4, '0');
    expect(parseReceivePackCommands(bytes(`${len}${line}0000`))).toEqual({
      ok: false,
      reason: 'malformed-command',
    });
  });

  test('MAX_COMMANDS is enforced', () => {
    const one = (ref: string) => {
      const command = `${'0'.repeat(40)} ${'1'.repeat(40)} ${ref}`;
      return `${(command.length + 4).toString(16).padStart(4, '0')}${command}`;
    };
    let body = '';
    for (let i = 0; i <= MAX_COMMANDS; i += 1) body += one(`refs/heads/b${i}`);
    const result = parseReceivePackCommands(bytes(`${body}0000`));
    expect(result).toEqual({ ok: false, reason: 'too-many-commands' });
  });
});

// ─── streaming ───────────────────────────────────────────────────────────────

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[i]!);
      i += 1;
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) parts.push(value);
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

describe('peek + replay', () => {
  test('the command list may straddle chunk boundaries', () => {
    // Real chunking is at the mercy of the network; a 1-byte-at-a-time split is
    // the adversarial version of what a slow client actually does.
    const body = CAPTURED_THREE_REFS + PACK;
    const chunks = [...body].map((ch) => bytes(ch));
    return (async () => {
      const { parsed } = await peekReceivePackHead(streamOf(chunks).getReader());
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.commands.map((c) => c.ref)).toEqual([
        'refs/heads/main',
        'refs/heads/feat-a',
        'refs/heads/feat-b',
      ]);
    })();
  });

  test('replay re-emits the body byte-identically, head + untouched remainder', async () => {
    // The whole design rests on this: we inspect the prefix and forward the
    // push unchanged. A single dropped or duplicated byte corrupts the packfile.
    const body = bytes(CAPTURED_SINGLE_REF_MAIN + PACK);
    const chunks = [body.subarray(0, 60), body.subarray(60, 150), body.subarray(150)];
    const reader = streamOf(chunks.map((c) => new Uint8Array(c))).getReader();
    const peek = await peekReceivePackHead(reader);
    const replayed = await collect(
      replayReceivePackBody({ head: peek.head, reader, upstreamDone: peek.upstreamDone }),
    );
    expect(replayed).toEqual(body);
  });

  test('replay does not buffer the packfile: only the command-list prefix is held', async () => {
    // 8 MiB of "pack" split into 1 MiB chunks. The peeked head must stay tiny —
    // buffering a whole push would OOM the API on a large repo.
    const prefix = bytes(CAPTURED_SINGLE_REF_MAIN);
    const packChunks = Array.from({ length: 8 }, () => new Uint8Array(1024 * 1024).fill(7));
    const reader = streamOf([prefix, ...packChunks]).getReader();
    const peek = await peekReceivePackHead(reader);
    const headBytes = peek.head.reduce((n, c) => n + c.length, 0);
    expect(headBytes).toBe(prefix.length);
    const replayed = await collect(
      replayReceivePackBody({ head: peek.head, reader, upstreamDone: peek.upstreamDone }),
    );
    expect(replayed.length).toBe(prefix.length + 8 * 1024 * 1024);
  });

  test('a body that ends before the flush-pkt is malformed, not forever-incomplete', async () => {
    const truncated = bytes(CAPTURED_SINGLE_REF_MAIN.slice(0, 40));
    const { parsed } = await peekReceivePackHead(streamOf([truncated]).getReader());
    expect(parsed).toEqual({ ok: false, reason: 'malformed-pkt' });
  });

  test('drain discards the remainder so git will display our rejection', async () => {
    // Replying before consuming the request makes git print "the remote end
    // hung up unexpectedly" and swallow our message entirely.
    const reader = streamOf([new Uint8Array(1024), new Uint8Array(2048)]).getReader();
    expect(await drainRequestBody(reader)).toEqual({ drained: true, bytes: 3072 });
  });

  test('drain gives up at the byte cap instead of reading forever', async () => {
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024));
      },
    });
    const result = await drainRequestBody(endless.getReader(), { maxBytes: 4 * 1024 * 1024 });
    expect(result.drained).toBe(false);
    expect(result.bytes).toBeLessThanOrEqual(8 * 1024 * 1024);
  });
});
