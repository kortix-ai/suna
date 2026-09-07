/**
 * git `receive-pack` request parsing + response encoding — pure, no I/O.
 *
 * A push body is:
 *
 *   <pkt-line command>*  flush-pkt  [push-options section]  [PACK…]
 *
 * where each command is
 *
 *   <old-sha> SP <new-sha> SP <refname> [NUL SP-separated-capabilities] LF
 *
 * The commands are the ONLY part the proxy needs in order to decide whether a
 * push is allowed: they name every ref the push would move, and (via all-zero
 * SHAs) whether each is a create or a delete. They sit in the first few hundred
 * bytes, ahead of the pack — measured 158 bytes for a one-ref push against
 * git 2.39.1 — so the proxy can buffer that prefix, decide, and either refuse
 * before a single pack byte is uploaded or replay the prefix and stream the
 * rest through untouched.
 *
 * Three protocol details are load-bearing and each was verified against a real
 * `git push` (see receive-pack.test.ts for the captured bytes):
 *
 *  1. A pkt-line's 4-hex length counts BYTES, including the 4 length bytes
 *     themselves. Using a JS string length instead corrupts the frame the
 *     moment a reason contains a non-ASCII character, and git dies with
 *     `protocol error: bad line length character`.
 *  2. When the client advertised `side-band-64k` — git does, unconditionally,
 *     since 2.x — the RESPONSE must be sideband-framed: the report-status
 *     pkt-lines are payload on band 1, wrapped in an outer pkt-line. Sending
 *     the report raw makes git read its first payload byte as a band number
 *     and abort with `protocol error: bad band #117`.
 *  3. git does NOT gzip a receive-pack request body (it gzips upload-pack
 *     requests only), so the command section is readable directly. A body that
 *     nonetheless arrives content-encoded is refused rather than guessed at.
 */

/** One ref update a push is asking the server to perform. */
export interface RefUpdate {
  /** Ref the client believes is current; all zeros when creating the ref. */
  oldSha: string;
  /** Ref the client wants to write; all zeros when deleting the ref. */
  newSha: string;
  /** Fully-qualified ref name, e.g. `refs/heads/main`. */
  ref: string;
}

export type ReceivePackParse =
  | { status: 'ok'; updates: RefUpdate[]; capabilities: string[]; commandBytes: number }
  /** The buffer does not yet contain a complete command section. */
  | { status: 'need-more' }
  | { status: 'invalid'; reason: string };

/** SHA-1 (40) and SHA-256 (64) object ids both appear in the wild. */
const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function isZeroSha(sha: string): boolean {
  return /^0+$/.test(sha) && SHA_RE.test(sha);
}

/** A create sets a ref that did not exist. */
export function isCreate(update: RefUpdate): boolean {
  return isZeroSha(update.oldSha);
}

/** A delete removes the ref entirely (`git push origin :branch`). */
export function isDelete(update: RefUpdate): boolean {
  return isZeroSha(update.newSha);
}

/**
 * Parse the command section at the head of a receive-pack request body.
 *
 * Returns `need-more` while the buffer is still short of the terminating
 * flush-pkt, so a caller can keep reading from the request stream. Callers MUST
 * bound how long they are willing to wait — see `MAX_COMMAND_SECTION_BYTES`.
 */
export function parseReceivePackCommands(buf: Uint8Array): ReceivePackParse {
  const updates: RefUpdate[] = [];
  let capabilities: string[] = [];
  let offset = 0;

  for (;;) {
    if (offset + 4 > buf.length) return { status: 'need-more' };
    const header = latin1(buf, offset, offset + 4);
    if (!/^[0-9a-f]{4}$/i.test(header)) {
      return { status: 'invalid', reason: 'malformed pkt-line length' };
    }
    const length = parseInt(header, 16);
    // flush-pkt terminates the command section.
    if (length === 0) return { status: 'ok', updates, capabilities, commandBytes: offset + 4 };
    if (length < 4) return { status: 'invalid', reason: 'malformed pkt-line length' };
    if (offset + length > buf.length) return { status: 'need-more' };

    let payload = latin1(buf, offset + 4, offset + length);
    offset += length;

    // Capabilities ride on the first command only, after a NUL.
    const nul = payload.indexOf('\0');
    if (nul >= 0) {
      capabilities = payload
        .slice(nul + 1)
        .replace(/\n$/, '')
        .split(' ')
        .filter(Boolean);
      payload = payload.slice(0, nul);
    }
    payload = payload.replace(/\n$/, '');

    // `<old> SP <new> SP <ref>` — split on the first two spaces only, since a
    // ref name itself can never contain a space (git forbids it).
    const first = payload.indexOf(' ');
    const second = first < 0 ? -1 : payload.indexOf(' ', first + 1);
    if (first < 0 || second < 0) {
      return { status: 'invalid', reason: 'malformed receive-pack command' };
    }
    const oldSha = payload.slice(0, first);
    const newSha = payload.slice(first + 1, second);
    const ref = payload.slice(second + 1);
    if (!SHA_RE.test(oldSha) || !SHA_RE.test(newSha)) {
      return { status: 'invalid', reason: 'malformed object id in receive-pack command' };
    }
    if (!ref.startsWith('refs/')) {
      return { status: 'invalid', reason: 'receive-pack command names an unqualified ref' };
    }
    updates.push({ oldSha, newSha, ref });
  }
}

/**
 * How much of a request body we will buffer looking for the flush-pkt that ends
 * the command section. A one-ref push is ~160 bytes and each extra ref adds
 * ~100; 1 MiB is >10k refs, far past any real push, and bounds the memory a
 * hostile client can make the proxy hold.
 */
export const MAX_COMMAND_SECTION_BYTES = 1024 * 1024;

/** Encode one pkt-line from raw bytes. The length prefix counts BYTES. */
export function pktLineBytes(body: Uint8Array): Uint8Array {
  const header = Buffer.from((body.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, Buffer.from(body)]);
}

/** Encode one pkt-line. The length prefix counts BYTES — see the header note. */
export function pktLine(payload: string): Uint8Array {
  return pktLineBytes(Buffer.from(payload, 'utf8'));
}

const FLUSH_PKT = Buffer.from('0000', 'ascii');

/** Per-ref outcome for a report-status response. */
export interface RefReport {
  ref: string;
  /** Absent = accepted; present = rejected with this (ASCII, single-line) reason. */
  reason?: string;
}

/**
 * Build a `application/x-git-receive-pack-result` body reporting the outcome of
 * every command, without any of them having been performed.
 *
 * git renders a rejected ref as
 *   ` ! [remote rejected] main -> main (<reason>)`
 * and exits non-zero — the same shape a server-side hook rejection produces, so
 * a refusal reads as a policy decision rather than a broken transport.
 */
export function encodeReportStatus(reports: RefReport[], opts: { sideband: boolean }): Uint8Array {
  const lines: Uint8Array[] = [pktLine('unpack ok\n')];
  for (const report of reports) {
    lines.push(
      report.reason
        ? pktLine(`ng ${report.ref} ${sanitizeReason(report.reason)}\n`)
        : pktLine(`ok ${report.ref}\n`),
    );
  }
  lines.push(FLUSH_PKT);
  const inner = Buffer.concat(lines);
  if (!opts.sideband) return inner;
  // Band 1 = primary payload. The band byte PREFIXES the payload INSIDE the
  // outer pkt-line; omitting it is what makes git abort with
  // `protocol error: bad band #<first payload byte>`. Built at the byte level
  // because a latin1 -> utf8 round-trip through a string would corrupt any byte
  // >= 0x80. The report is far under the 64k band limit, so it never needs
  // splitting across packets.
  const BAND_PRIMARY = 0x01;
  return Buffer.concat([
    pktLineBytes(Buffer.concat([Buffer.from([BAND_PRIMARY]), inner])),
    FLUSH_PKT,
  ]);
}

/** True when the client negotiated a sideband channel for the response. */
export function wantsSideband(capabilities: string[]): boolean {
  return capabilities.includes('side-band-64k') || capabilities.includes('side-band');
}

/**
 * git accepts any single-line reason and prints it verbatim in parentheses.
 * Strip anything that would break the pkt-line framing or the report grammar.
 */
function sanitizeReason(reason: string): string {
  return (
    reason
      .replace(/[\r\n\0]/g, ' ')
      // Non-ASCII would still frame correctly (pktLine counts bytes) but renders
      // unpredictably across terminals; keep refusals plain.
      .replace(/[^\x20-\x7e]/g, '')
      .trim()
      .slice(0, 200) || 'rejected'
  );
}

function latin1(buf: Uint8Array, start: number, end: number): string {
  return Buffer.from(buf.buffer, buf.byteOffset + start, end - start).toString('latin1');
}
