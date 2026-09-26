import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { findSessionAttachments, type SessionAttachmentReference } from '@kortix/sdk';

import { kortixFromAuth, withKortixScope } from '../api/sdk.ts';
import {
  emitJson,
  locateSessionAnywhere,
  surfaceApiError,
  takeFlagBool,
  takeFlagValue,
  fail,
} from '../command-helpers.ts';
import { C, help, pad, status } from '../style.ts';
import { readSavedTranscript } from './sessions-chat.ts';

type CtxOpts = { projectArg?: string; hostArg?: string };

/** Every saved window, not a tail: a file attached on day one still counts. */
const WHOLE_TRANSCRIPT = 20_000;

const ATTACHMENTS_HELP = help`Usage: kortix sessions attachments <session-id> [options]

List the files a session holds in private storage — what users attached, and
copies of the files the agent showed — and download them. Works while the
session is stopped: neither the list nor the bytes need its sandbox.

  --download <attachment-id>   Download one file.
  --all                        Download every file.
  --out <dir>                  Where downloads are written (default: .).
                               Created if missing. Nothing is overwritten.
  --json                       Emit structured JSON for scripting.
  --project <id>               Operate on this project id (default: linked).
  --host <name>                Operate against a non-default Kortix host.
  -h, --help                   Show this help.

Files come from the session's saved transcript, which is written at the end of
every turn. A project stores them only with Session Transcript History enabled
(Settings → Feature flags).`;

/**
 * A download name that can only land inside `dir`.
 *
 * The name is untrusted: a user or an agent chose it. Only its last segment is
 * kept, control characters and a leading dot are removed, and an existing file
 * is never overwritten — the next free `name (n).ext` is used instead.
 */
export function safeDownloadPath(dir: string, name: string | null, attachmentId: string): string {
  const fallback = `attachment-${attachmentId.slice(0, 8)}`;
  // eslint-disable-next-line no-control-regex
  const cleaned = path.basename((name ?? '').replace(/\\/g, '/')).replace(/[\u0000-\u001f\u007f]/g, '');
  const base = cleaned.replace(/^\.+/, '').trim() || fallback;
  const ext = path.extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  let candidate = path.join(dir, base);
  for (let n = 1; existsSync(candidate); n++) candidate = path.join(dir, `${stem} (${n})${ext}`);
  return candidate;
}

/**
 * `kortix sessions attachments` — list and download a session's stored files.
 *
 * The saved transcript is the index: capture records a `kortix-attachment://`
 * reference for every upload and for every file an agent showed, and
 * `findSessionAttachments` (SDK) reads them back. The bytes come from the
 * platform's private store. Neither step touches the sandbox, which is the
 * point — a stopped session's files used to be reachable only by waking it.
 */
export async function runSessionsAttachments(argv: string[]): Promise<number> {
  const rest = [...argv];
  if (rest.includes('-h') || rest.includes('--help')) {
    process.stdout.write(`${ATTACHMENTS_HELP}\n`);
    return 0;
  }

  let projectArg: string | undefined;
  let hostArg: string | undefined;
  let downloadId: string | undefined;
  let outDir: string | undefined;
  let all = false;
  let json = false;
  try {
    projectArg = takeFlagValue(rest, ['--project']);
    hostArg = takeFlagValue(rest, ['--host']);
    downloadId = takeFlagValue(rest, ['--download']);
    outDir = takeFlagValue(rest, ['--out', '-o']);
    all = takeFlagBool(rest, ['--all']);
    json = takeFlagBool(rest, ['--json']);
  } catch (err) {
    return fail((err as Error).message);
  }
  const positional = rest.filter((a) => !a.startsWith('-'));
  if (positional.length !== 1) {
    process.stderr.write(`${status.err('Pass exactly one session id.')}\n\n${ATTACHMENTS_HELP}\n`);
    return 2;
  }
  if (downloadId && all) return fail('Pass --download <id> or --all, not both.');
  const sessionId = positional[0]!;
  const opts: CtxOpts = { projectArg, hostArg };

  const found = await locateSessionAnywhere(
    sessionId,
    opts,
    (host) => `kortix sessions attachments ${sessionId} --host ${host}`,
  );
  if (!found) return 1;
  const { projectId, auth, session } = found.located;

  const saved = await readSavedTranscript(auth, projectId, session.session_id, WHOLE_TRANSCRIPT);
  if (saved.kind === 'error') return surfaceApiError(saved.error);
  const attachments: SessionAttachmentReference[] =
    saved.kind === 'ok' ? findSessionAttachments(saved.messages) : [];

  const wanted = all
    ? attachments
    : downloadId
      ? attachments.filter((a) => a.attachment_id === downloadId)
      : [];
  if (downloadId && wanted.length === 0) {
    process.stderr.write(
      `${status.err(`No stored file ${downloadId} in session ${session.session_id}.`)}\n` +
        `  ${C.dim}List them with \`kortix sessions attachments ${session.session_id}\`.${C.reset}\n`,
    );
    return 1;
  }

  const downloaded: Array<{ attachment_id: string; path: string; bytes: number }> = [];
  if (wanted.length > 0) {
    const dir = path.resolve(outDir ?? '.');
    mkdirSync(dir, { recursive: true });
    const handle = kortixFromAuth(auth).session(projectId, session.session_id);
    for (const attachment of wanted) {
      let bytes: Uint8Array;
      try {
        const blob = await withKortixScope(auth, () => handle.attachments.read(attachment.attachment_id));
        bytes = new Uint8Array(await blob.arrayBuffer());
      } catch (err) {
        return surfaceApiError(err);
      }
      const target = safeDownloadPath(dir, attachment.filename, attachment.attachment_id);
      writeFileSync(target, bytes, { flag: 'wx' });
      downloaded.push({ attachment_id: attachment.attachment_id, path: target, bytes: bytes.byteLength });
    }
  }

  if (json) {
    emitJson({
      session_id: session.session_id,
      source: saved.kind === 'ok' ? 'saved' : 'none',
      attachments,
      ...(wanted.length > 0 ? { downloaded } : {}),
    });
    return 0;
  }

  if (downloaded.length > 0) {
    for (const d of downloaded) {
      process.stdout.write(`${status.ok(`${d.path}`)} ${C.faded}(${d.bytes} bytes)${C.reset}\n`);
    }
    return 0;
  }

  if (attachments.length === 0) {
    process.stdout.write(
      `${C.dim}No stored files in session ${session.session_id}'s saved transcript.${C.reset}\n`,
    );
    return 0;
  }
  const idW = 36;
  const nameW = Math.min(40, Math.max(8, ...attachments.map((a) => (a.filename ?? '').length)));
  process.stdout.write(
    `\n${C.dim}${pad('ATTACHMENT', idW)}  ${pad('NAME', nameW)}  FROM${C.reset}\n`,
  );
  for (const a of attachments) {
    const who = a.role === 'assistant' ? 'shown by agent' : a.role;
    process.stdout.write(
      `${pad(a.attachment_id, idW)}  ${pad(a.filename ?? '—', nameW)}  ${C.faded}${who}${C.reset}\n`,
    );
  }
  process.stdout.write(
    `\n${C.dim}Download with \`kortix sessions attachments ${session.session_id} --download <id>\` ` +
      `or \`--all\`.${C.reset}\n\n`,
  );
  return 0;
}
