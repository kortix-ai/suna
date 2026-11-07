import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { findSessionAttachments, type Kortix, type SessionAttachmentReference } from '@kortix/sdk';

import type { Auth } from '../api/auth.ts';
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
import { readStoredSessionLog, type StoredSessionLog } from './sessions-chat.ts';

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
  --workspace <id>             Operate on this workspace id (default: linked).
  --host <name>                Operate against a non-default Kortix host.
  -h, --help                   Show this help.

Files come from the session's stored session log, which is written at the end
of every turn (JSON "source": "log").`;

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

interface DownloadedAttachment {
  attachment_id: string;
  path: string;
  bytes: number;
}

/** Write each wanted file into `outDir` (created if missing): the rows, or the exit code of the first read that failed. */
async function downloadAttachments(
  handle: ReturnType<Kortix['session']>,
  auth: Auth,
  wanted: SessionAttachmentReference[],
  outDir: string | undefined,
): Promise<DownloadedAttachment[] | number> {
  const dir = path.resolve(outDir ?? '.');
  mkdirSync(dir, { recursive: true });
  const downloaded: DownloadedAttachment[] = [];
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
  return downloaded;
}

function renderAttachmentTable(attachments: SessionAttachmentReference[], sessionId: string): void {
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
    `\n${C.dim}Download with \`kortix sessions attachments ${sessionId} --download <id>\` ` +
      `or \`--all\`.${C.reset}\n\n`,
  );
}

/** The flags and the one session id, or the usage-error exit code. */
function parseAttachmentsArgs(rest: string[]) {
  let projectArg: string | undefined;
  let hostArg: string | undefined;
  let downloadId: string | undefined;
  let outDir: string | undefined;
  let all = false;
  let json = false;
  try {
    projectArg = takeFlagValue(rest, ['--project', '--workspace']);
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
  return { opts, sessionId, downloadId, outDir, all, json };
}

function printAttachments(
  sessionId: string,
  source: 'log' | 'none',
  attachments: SessionAttachmentReference[],
  downloaded: DownloadedAttachment[],
  json: boolean,
): number {
  if (json) {
    emitJson({
      session_id: sessionId,
      source,
      attachments,
      ...(downloaded.length > 0 ? { downloaded } : {}),
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
      `${C.dim}No stored files in session ${sessionId}'s saved transcript.${C.reset}\n`,
    );
    return 0;
  }
  renderAttachmentTable(attachments, sessionId);
  return 0;
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

  const args = parseAttachmentsArgs(rest);
  if (typeof args === 'number') return args;
  const { opts, sessionId, downloadId, outDir, all, json } = args;

  const found = await locateSessionAnywhere(
    sessionId,
    opts,
    (host) => `kortix sessions attachments ${sessionId} --host ${host}`,
  );
  if (!found) return 1;
  const { projectId, auth, session } = found.located;

  // The stored session log is the index (every thread); no v1 transcript (`GET …/transcript`, P8.3).
  const handle = kortixFromAuth(auth).session(projectId, session.session_id);
  let stored: StoredSessionLog | null;
  try {
    stored = await readStoredSessionLog((query) => withKortixScope(auth, () => handle.log(query)), WHOLE_TRANSCRIPT);
  } catch (err) {
    return surfaceApiError(err);
  }
  const attachments: SessionAttachmentReference[] = stored ? findSessionAttachments(stored.threads.flatMap((thread) => thread.messages)) : [];
  const source: 'log' | 'none' = stored ? 'log' : 'none';

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

  const downloaded = wanted.length > 0 ? await downloadAttachments(handle, auth, wanted, outDir) : [];
  if (typeof downloaded === 'number') return downloaded;

  return printAttachments(session.session_id, source, attachments, downloaded, json);
}
