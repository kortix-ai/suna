/**
 * git-receive-pack wire parsing + git-native rejection, for the proxy's
 * ref-level protection (R-9.6: work reaches the default branch ONLY through a
 * change request).
 *
 * PURE — no DB/network/app imports, same discipline as `parse.ts` and
 * `upstream.ts`, so the wire format can be pinned by unit tests against real
 * captured bytes.
 *
 * The receive-pack request body is:
 *
 *   update-requests = *shallow ( command-list | push-cert )
 *   command-list    = PKT-LINE(command NUL capability-list) *PKT-LINE(command) flush-pkt
 *   command         = <old-oid> SP <new-oid> SP <ref-name>
 *
 * followed by the packfile. The command list is a BOUNDED PREFIX (one short
 * pkt-line per ref), which is the whole reason ref-level protection is possible
 * without buffering the pack: we peek the head, decide, and re-emit
 * `head + rest` as a stream. A large push must never be buffered — that would
 * OOM the API.
 *
 * The two details that would silently break real traffic if missed:
 *   1. Leading `shallow <oid>` pkt-lines. Every Kortix sandbox clones depth-1,
 *      so essentially EVERY agent push carries them before the first command.
 *      A parser assuming pkt #1 is a command misclassifies 100% of session
 *      pushes as unparseable.
 *   2. Capabilities appear on the FIRST command only (after a NUL); every
 *      later command is bare.
 */

/** Hard cap on how much of the body we will read looking for the flush-pkt
 *  that ends the command list. A real command list is 100–400 bytes; 1 MiB is
 *  ~10k refs of slack and still bounded memory. */
export const MAX_COMMAND_LIST_BYTES = 1024 * 1024;

/** Hard cap on commands in one push. Beyond this we refuse to reason about it. */
export const MAX_COMMANDS = 10_000;

/** A ref name is all-zero-oid → this command DELETES the ref. Still an update. */
const ZERO_OID_RE = /^0+$/;

/** git object ids: sha1 (40 hex) today, sha256 (64 hex) under
 *  `object-format=sha256`. Never hard-code 40. */
const OID_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;

export interface ReceivePackCommand {
  oldOid: string;
  newOid: string;
  ref: string;
  /** All-zero new-oid = the client is deleting this ref. */
  isDelete: boolean;
}

export type ParseFailureReason =
  /** Ran out of bytes before the flush-pkt that ends the command list. The
   *  caller may read more and retry, up to MAX_COMMAND_LIST_BYTES. */
  | 'incomplete'
  /** `git push --signed`: commands are nested inside push-cert…push-cert-end. */
  | 'push-cert'
  /** Length prefix isn't 4 hex chars, or is a delim/response-end pkt. */
  | 'malformed-pkt'
  /** A pkt-line in command position isn't `<oid> SP <oid> SP <ref>`. */
  | 'malformed-command'
  /** Command list exceeded MAX_COMMANDS. */
  | 'too-many-commands'
  /** Command list exceeded MAX_COMMAND_LIST_BYTES without a flush-pkt. */
  | 'too-large'
  /** Flush-pkt arrived with zero commands. */
  | 'no-commands'
  /** Body carries a content-encoding we will not decode, so the head is
   *  unreadable. git 2.39 never gzips a receive-pack body (the pack is already
   *  compressed) but libgit2/JGit/an intermediary might — and an agent with a
   *  shell could set one deliberately to blind the parser. */
  | 'content-encoding'
  /** POST with no request body at all. */
  | 'no-body';

export type ParseReceivePackResult =
  | { ok: true; commands: ReceivePackCommand[]; caps: string[] }
  | { ok: false; reason: ParseFailureReason };

const decoder = new TextDecoder('utf-8', { fatal: false });
const encoder = new TextEncoder();

interface PktLine {
  kind: 'data' | 'flush';
  payload: Uint8Array;
  /** Offset just past this pkt-line. */
  next: number;
}

/**
 * Read one pkt-line at `offset`. Returns null when there aren't enough bytes
 * yet (caller reads more), or throws-by-sentinel via `malformed`.
 */
function readPktLine(
  buf: Uint8Array,
  offset: number,
): PktLine | 'incomplete' | 'malformed' {
  if (offset + 4 > buf.length) return 'incomplete';
  const lenHex = decoder.decode(buf.subarray(offset, offset + 4));
  if (!/^[0-9a-f]{4}$/i.test(lenHex)) return 'malformed';
  const len = Number.parseInt(lenHex, 16);
  if (len === 0) return { kind: 'flush', payload: new Uint8Array(0), next: offset + 4 };
  // 0001 (delim) and 0002 (response-end) are protocol-v2 framing and are not
  // valid inside a receive-pack command list. 0003 is impossible (< header).
  if (len < 4) return 'malformed';
  if (offset + len > buf.length) return 'incomplete';
  return { kind: 'data', payload: buf.subarray(offset + 4, offset + len), next: offset + len };
}

/** Strip a single trailing LF, which git appends to most pkt-line payloads. */
function stripLf(payload: Uint8Array): Uint8Array {
  if (payload.length > 0 && payload[payload.length - 1] === 0x0a) {
    return payload.subarray(0, payload.length - 1);
  }
  return payload;
}

function parseCommandText(text: string): ReceivePackCommand | null {
  const parts = text.split(' ');
  if (parts.length < 3) return null;
  const [oldOid, newOid] = parts;
  // Ref names cannot contain a space, so anything after the second space is
  // the ref verbatim — rejoin defensively rather than trusting parts.length===3.
  const ref = parts.slice(2).join(' ');
  if (!oldOid || !newOid || !ref) return null;
  if (!OID_RE.test(oldOid) || !OID_RE.test(newOid)) return null;
  if (ref.includes('\0') || ref.includes(' ')) return null;
  return { oldOid, newOid, ref, isDelete: ZERO_OID_RE.test(newOid) };
}

/**
 * Parse the receive-pack command list from the HEAD of a request body.
 *
 * `head` need not contain the whole body — only enough to reach the flush-pkt
 * that terminates the command list. Short input yields
 * `{ ok: false, reason: 'incomplete' }` so the caller can read more.
 */
export function parseReceivePackCommands(head: Uint8Array): ParseReceivePackResult {
  const commands: ReceivePackCommand[] = [];
  let caps: string[] = [];
  let offset = 0;
  let sawCommand = false;

  for (;;) {
    if (offset > MAX_COMMAND_LIST_BYTES) return { ok: false, reason: 'too-large' };

    const pkt = readPktLine(head, offset);
    if (pkt === 'malformed') return { ok: false, reason: 'malformed-pkt' };
    if (pkt === 'incomplete') {
      // Only report 'incomplete' while there is still room to grow; past the
      // cap a missing flush-pkt is a hard failure, not a "read more".
      return {
        ok: false,
        reason: head.length >= MAX_COMMAND_LIST_BYTES ? 'too-large' : 'incomplete',
      };
    }

    if (pkt.kind === 'flush') {
      if (!sawCommand) return { ok: false, reason: 'no-commands' };
      return { ok: true, commands, caps };
    }

    const payload = stripLf(pkt.payload);
    offset = pkt.next;

    // Capabilities ride on the FIRST command only, after a NUL.
    const nul = payload.indexOf(0);
    const body = nul >= 0 ? payload.subarray(0, nul) : payload;
    const text = decoder.decode(body);

    if (!sawCommand && text.startsWith('shallow ')) {
      // Depth-1 clones (the Kortix sandbox default) announce their shallow
      // boundary BEFORE the command list. Skip; they are not commands.
      const oid = text.slice('shallow '.length).trim();
      if (!OID_RE.test(oid)) return { ok: false, reason: 'malformed-command' };
      continue;
    }

    if (!sawCommand && text.startsWith('push-cert')) {
      // `git push --signed` nests the commands inside a signed certificate.
      // We do not parse it; the caller decides what an unparseable head means.
      return { ok: false, reason: 'push-cert' };
    }

    const command = parseCommandText(text);
    if (!command) return { ok: false, reason: 'malformed-command' };

    if (!sawCommand && nul >= 0) {
      caps = decoder
        .decode(payload.subarray(nul + 1))
        .split(' ')
        .map((c) => c.trim())
        .filter(Boolean);
    }

    sawCommand = true;
    commands.push(command);
    if (commands.length > MAX_COMMANDS) return { ok: false, reason: 'too-many-commands' };
  }
}

// ─── git-native rejection ────────────────────────────────────────────────────

/** Largest pkt-line payload git accepts (65520 total − 4 length bytes). */
const MAX_PKT_PAYLOAD = 65516;

function pktLine(payload: Uint8Array | string): Uint8Array<ArrayBuffer> {
  const bytes = typeof payload === 'string' ? encoder.encode(payload) : payload;
  const len = bytes.length + 4;
  const header = encoder.encode(len.toString(16).padStart(4, '0'));
  const out = new Uint8Array(header.length + bytes.length);
  out.set(header, 0);
  out.set(bytes, header.length);
  return out;
}

const FLUSH_PKT = encoder.encode('0000');

function concatBytes(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Wrap `data` in sideband `band` pkt-lines, chunked to the pkt-line limit. */
function sideband(band: 1 | 2 | 3, data: Uint8Array): Uint8Array<ArrayBuffer>[] {
  const out: Uint8Array<ArrayBuffer>[] = [];
  const chunkSize = MAX_PKT_PAYLOAD - 1; // one byte for the band marker
  for (let at = 0; at < data.length; at += chunkSize) {
    const slice = data.subarray(at, Math.min(at + chunkSize, data.length));
    const framed = new Uint8Array(slice.length + 1);
    framed[0] = band;
    framed.set(slice, 1);
    out.push(pktLine(framed));
  }
  return out;
}

/** Reason strings live INSIDE a pkt-line: single line, bounded length. */
export function sanitizeReason(reason: string): string {
  return reason.replace(/[\r\n\0]+/g, ' ').trim().slice(0, 200);
}

export const PROTECTED_REF_REASON =
  'protected: agents land work through a change request. Push a branch, then: kortix cr open --head <branch>';

export function siblingRefReason(protectedRef: string): string {
  return sanitizeReason(`not attempted: this push also targeted the protected branch ${protectedRef}`);
}

export const DENIAL_PREAMBLE = 'Kortix: this push was refused by the git proxy.\n';

/**
 * Build the exact bytes of a git-native push rejection.
 *
 * This is deliberately NOT an HTTP 403: with a 403 git prints only
 * "RPC failed; HTTP 403" and "the remote end hung up unexpectedly" — the body
 * is never shown, so the caller (often an agent trying to self-correct) never
 * learns to open a change request instead. A 200 carrying a report-status
 * document with an `ng` per ref renders as a real `! [remote rejected]` line
 * AND still exits non-zero.
 *
 * `reasonFor` returns the per-ref reason. Every command gets an `ng`: we never
 * forwarded the request, so we cannot honestly report `ok` for sibling refs in
 * a mixed push.
 */
export function buildRejectionReport(input: {
  commands: ReceivePackCommand[];
  caps: string[];
  reasonFor: (command: ReceivePackCommand) => string;
  preamble?: string;
}): Uint8Array<ArrayBuffer> {
  const report: Uint8Array<ArrayBuffer>[] = [pktLine('unpack ok\n')];
  for (const command of input.commands) {
    report.push(pktLine(`ng ${command.ref} ${sanitizeReason(input.reasonFor(command))}\n`));
  }
  report.push(FLUSH_PKT);
  const reportBytes = concatBytes(report);

  // Sideband framing ONLY when the client negotiated it. Without side-band-64k
  // the client reads the report-status document straight off the wire, and an
  // unexpected band marker byte would corrupt the first line.
  if (!input.caps.includes('side-band-64k')) return reportBytes;

  const parts: Uint8Array<ArrayBuffer>[] = [];
  // Band 2 = progress/stderr: this is what surfaces as `remote: …`.
  parts.push(...sideband(2, encoder.encode(input.preamble ?? DENIAL_PREAMBLE)));
  // Band 1 = the packet stream the client parses as report-status(-v2).
  parts.push(...sideband(1, reportBytes));
  parts.push(FLUSH_PKT);
  return concatBytes(parts);
}

// ─── the rule ────────────────────────────────────────────────────────────────

export type ReceivePackDecision =
  | { action: 'allow'; reason: 'not-agent' | 'no-protected-ref' }
  | {
      action: 'deny';
      reason: 'protected-ref';
      matchedRefs: string[];
      commands: ReceivePackCommand[];
      caps: string[];
    }
  | { action: 'deny'; reason: 'unparseable'; detail: ParseFailureReason };

/**
 * The rule, as a pure function so it can be pinned exhaustively by tests.
 *
 * Agent principals may not update a protected ref — where "update" includes a
 * DELETE (all-zero new-oid) and a FORCE push (both are just ref updates on the
 * wire, with no distinguishing bit; only the server would know a non-force
 * update was a fast-forward, and we deny either way).
 *
 * A push that touches a protected ref is refused WHOLLY. git applies a
 * multi-ref push as one request, so `git push origin feature main` would
 * otherwise sneak `main` past a per-ref filter — and since we never forward the
 * request, no sibling ref is actually applied either.
 *
 * FAILURE MODE — unparseable ⇒ DENY, and only agents are ever parsed.
 * The asymmetry is the crux: failing OPEN costs the entire control (an agent
 * with a shell can gzip the body, `push.gpgSign`, or use another git
 * implementation to make the head unreadable — a control you can switch off by
 * compressing your request is not a control), while failing CLOSED cannot break
 * a single human push, because human principals skip the parse entirely.
 */
export function decideReceivePack(input: {
  principalClass: 'agent' | 'human';
  protectedRefs: readonly string[];
  parsed: ParseReceivePackResult;
}): ReceivePackDecision {
  if (input.principalClass !== 'agent') return { action: 'allow', reason: 'not-agent' };

  if (!input.parsed.ok) {
    return { action: 'deny', reason: 'unparseable', detail: input.parsed.reason };
  }

  const protectedSet = new Set(input.protectedRefs);
  const matchedRefs = input.parsed.commands
    .filter((command) => protectedSet.has(command.ref))
    .map((command) => command.ref);

  if (matchedRefs.length === 0) return { action: 'allow', reason: 'no-protected-ref' };

  return {
    action: 'deny',
    reason: 'protected-ref',
    matchedRefs,
    commands: input.parsed.commands,
    caps: input.parsed.caps,
  };
}

// ─── streaming ───────────────────────────────────────────────────────────────

/**
 * Peek the head of a receive-pack body far enough to parse the command list.
 *
 * Returns the consumed chunks alongside the still-open reader so the caller can
 * re-emit `head + rest` WITHOUT buffering the packfile. Only the command-list
 * prefix (100–400 bytes in practice, 1 MiB worst case) is ever held in memory —
 * buffering a whole push would OOM the API on a large repo.
 */
export async function peekReceivePackHead(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<{ parsed: ParseReceivePackResult; head: Uint8Array[]; upstreamDone: boolean }> {
  const head: Uint8Array[] = [];
  let total = 0;
  let upstreamDone = false;
  let parsed: ParseReceivePackResult = { ok: false, reason: 'incomplete' };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      upstreamDone = true;
      break;
    }
    if (!value || value.length === 0) continue;
    head.push(value);
    total += value.length;

    // Re-parse from the top on each chunk: the command list can straddle chunk
    // boundaries, and a partial parse would need resumable state for no gain —
    // the input is capped at 1 MiB.
    parsed = parseReceivePackCommands(concatBytes(head));
    if (parsed.ok || parsed.reason !== 'incomplete') break;
    if (total >= MAX_COMMAND_LIST_BYTES) {
      parsed = { ok: false, reason: 'too-large' };
      break;
    }
  }

  // Stream ended before the flush-pkt: 'incomplete' is no longer "read more",
  // it is a truncated body.
  if (upstreamDone && !parsed.ok && parsed.reason === 'incomplete') {
    parsed = { ok: false, reason: 'malformed-pkt' };
  }

  return { parsed, head, upstreamDone };
}

/**
 * Rebuild a request body from the peeked head plus the unread remainder.
 *
 * `start` enqueues the buffered head; `pull` forwards one upstream chunk at a
 * time, so backpressure is preserved and the packfile never accumulates.
 */
export function replayReceivePackBody(input: {
  head: Uint8Array[];
  reader: ReadableStreamDefaultReader<Uint8Array>;
  upstreamDone: boolean;
}): ReadableStream<Uint8Array> {
  const { head, reader, upstreamDone } = input;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of head) controller.enqueue(chunk);
      if (upstreamDone) controller.close();
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      if (value) controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/** Bytes we will read-and-discard before responding to a denied push. */
export const MAX_DRAIN_BYTES = 64 * 1024 * 1024;
/** Wall-clock budget for that drain. */
export const MAX_DRAIN_MS = 20_000;

/**
 * Read and DISCARD the rest of a denied push (O(1) memory).
 *
 * git will not display our rejection if we reply before consuming the request:
 * it reports "unexpected disconnect while reading sideband packet" / "the
 * remote end hung up unexpectedly" and our message — the one telling the caller
 * to open a change request — never appears. Bounded by bytes and time; on
 * exceeding either we cancel and accept the ugly client error.
 */
export async function drainRequestBody(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  opts: { maxBytes?: number; maxMs?: number } = {},
): Promise<{ drained: boolean; bytes: number }> {
  const maxBytes = opts.maxBytes ?? MAX_DRAIN_BYTES;
  const deadline = Date.now() + (opts.maxMs ?? MAX_DRAIN_MS);
  let bytes = 0;
  try {
    for (;;) {
      if (Date.now() > deadline) {
        await reader.cancel('kortix: drain timeout').catch(() => {});
        return { drained: false, bytes };
      }
      const { done, value } = await reader.read();
      if (done) return { drained: true, bytes };
      bytes += value?.length ?? 0;
      if (bytes > maxBytes) {
        await reader.cancel('kortix: drain cap').catch(() => {});
        return { drained: false, bytes };
      }
    }
  } catch {
    return { drained: false, bytes };
  }
}

/** Build the denial body for a `protected-ref` decision. */
export function buildProtectedRefRejection(decision: {
  matchedRefs: string[];
  commands: ReceivePackCommand[];
  caps: string[];
}): Uint8Array<ArrayBuffer> {
  const matched = new Set(decision.matchedRefs);
  const firstMatch = decision.matchedRefs[0] ?? '';
  return buildRejectionReport({
    commands: decision.commands,
    caps: decision.caps,
    reasonFor: (command) =>
      matched.has(command.ref) ? PROTECTED_REF_REASON : siblingRefReason(firstMatch),
  });
}
