// kortix submit — the standardized work-submission verb. Records a session's
// finished work as a review item for a human to review — the same shape as a
// change request (a title, a description, and attachments), but for anything,
// not just code. Attachments are committed on the current branch, pushed, and
// pinned server-side under a keep-ref (refs/kortix/submissions/<id>) so they
// outlive the sandbox; a submission with no attachments is just a note.
// `show` presents in-conversation, `submit` records for review.

import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { emitJson, resolveProjectContext, surfaceApiError, takeFlagBool, takeFlagValue } from '../command-helpers.ts';
import { ApiError } from '../api/client.ts';
import { C, status } from '../style.ts';

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const AWAIT_POLL_MS = 5_000;

const HELP = `Usage: kortix submit --title "<text>" [options]

Submit finished work for human review — like opening a change request, but
for anything (a report, a document, an answer, generated assets), not just
code. With --attach, the named files are committed on the current branch,
pushed, and pinned so they survive the sandbox; with no attachments it's a
note carrying just the title + description.

Options:
  --title "<text>"        Required. Plain-language name for the work.
  --description "<text>"  What it is / what to review. Doubles as the body of
                          a note when there are no attachments. Alias: --body.
  --attach <path>         File to attach (repeatable, 25MB each). Alias: --attachment.
  --session <id>          Attribute the submission to a session. Only needed
                          with a non-session token (e.g. from your laptop);
                          inside a sandbox the session is read from the token.
  --await                 Block until a human verdict; exit code reflects it
                          (0 approved, 3 changes requested, 4 rejected).
  --await-timeout <sec>   Give up waiting after this many seconds (default: no
                          timeout). Exit 5 on timeout; the item stays open.
  --json                  Print the review item as JSON.

Global options:
  --project <id>     Operate on this project id (default: linked).
  --host <name>      Operate against a non-default Kortix host.
  -h, --help         Show this help.

Requires the project's Work Submission experimental feature to be enabled
(Customize → Settings → Experimental). Inside an agent sandbox the CLI reads
KORTIX_CLI_TOKEN and KORTIX_PROJECT_ID from the environment automatically —
you don't need to log in or link, and the submission binds to that session's
token. (KORTIX_TOKEN is the sandbox service key, not a CLI token.)
`;

const EXT_KIND: Record<string, string> = {
  md: 'markdown',
  markdown: 'markdown',
  txt: 'text',
  csv: 'csv',
  tsv: 'csv',
  json: 'code',
  html: 'html',
  htm: 'html',
  pdf: 'pdf',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  svg: 'image',
  mp4: 'video',
  webm: 'video',
  mp3: 'audio',
  wav: 'audio',
  xlsx: 'xlsx',
  docx: 'docx',
  pptx: 'pptx',
};

interface ReviewItemResponse {
  review_item_id: string;
  status: string;
  title: string;
  feedback: string | null;
  detail: Record<string, unknown>;
}

function fileKind(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return EXT_KIND[ext] ?? 'file';
}

function git(args: string[], cwd?: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function gitOk(args: string[], cwd?: string): boolean {
  try {
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

export async function runSubmit(argv: string[]): Promise<number> {
  if (argv[0] === '-h' || argv[0] === '--help') {
    process.stdout.write(HELP);
    return 0;
  }

  const rest = [...argv];
  let title: string | undefined;
  let description: string | undefined;
  let sessionFlag: string | undefined;
  let projectFlag: string | undefined;
  let hostFlag: string | undefined;
  let awaitVerdict = false;
  let awaitTimeoutRaw: string | undefined;
  let json = false;
  const attachments: string[] = [];
  try {
    title = takeFlagValue(rest, ['--title']);
    description = takeFlagValue(rest, ['--description', '--body']);
    sessionFlag = takeFlagValue(rest, ['--session']);
    projectFlag = takeFlagValue(rest, ['--project']);
    hostFlag = takeFlagValue(rest, ['--host']);
    awaitVerdict = takeFlagBool(rest, ['--await']);
    awaitTimeoutRaw = takeFlagValue(rest, ['--await-timeout']);
    json = takeFlagBool(rest, ['--json']);
    // --attach is repeatable — drain until absent.
    for (;;) {
      const a = takeFlagValue(rest, ['--attach', '--attachment']);
      if (a === undefined) break;
      attachments.push(a);
    }
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }
  if (rest.length > 0) {
    process.stderr.write(`${status.err(`unexpected argument "${rest[0]}"`)}\n\n${HELP}`);
    return 2;
  }
  if (!title?.trim()) {
    process.stderr.write(`${status.err('--title is required.')}\n\n${HELP}`);
    return 2;
  }
  if (attachments.length === 0 && !description?.trim()) {
    process.stderr.write(`${status.err('Pass a --description, at least one --attach, or both.')}\n`);
    return 2;
  }
  const awaitTimeoutSec = awaitTimeoutRaw !== undefined ? Number(awaitTimeoutRaw) : undefined;
  if (awaitTimeoutSec !== undefined && (!Number.isFinite(awaitTimeoutSec) || awaitTimeoutSec <= 0)) {
    process.stderr.write(`${status.err('--await-timeout must be a positive number of seconds.')}\n`);
    return 2;
  }

  const ctx = await resolveProjectContext({ projectArg: projectFlag, hostArg: hostFlag });
  if (!ctx) return 1;

  const desc = description?.trim();
  const detail: Record<string, unknown> = { submission_version: 1 };

  if (attachments.length > 0) {
    const pinned = pinAttachments(attachments);
    if (typeof pinned === 'number') return pinned;
    detail.storage = 'git';
    detail.git = pinned;
  } else {
    // A note: the description IS the submitted content.
    detail.storage = 'inline';
    detail.content = desc;
  }

  const body: Record<string, unknown> = {
    kind: 'output',
    title: title.trim(),
    ...(desc ? { summary: desc } : {}),
    detail,
  };
  // Session binding is authoritative from the token when it is session-scoped
  // (the sandbox case — the server reads the session off the credential). An
  // explicit --session only supplies the session for a non-session token (e.g.
  // running the CLI from a laptop), and the server still validates it.
  if (sessionFlag?.trim()) body.session_id = sessionFlag.trim();

  let item: ReviewItemResponse;
  try {
    item = await ctx.client.post<ReviewItemResponse>(`/projects/${ctx.projectId}/review/items`, body);
  } catch (err) {
    // A 403 here is almost always the work_submission flag being off — the
    // server sends a precise, actionable message; show it verbatim rather than
    // the generic "Forbidden".
    if (err instanceof ApiError && err.status === 403) {
      process.stderr.write(`${status.err(err.message)}\n`);
      return 1;
    }
    return surfaceApiError(err);
  }

  if (!awaitVerdict) {
    if (json) {
      emitJson(item);
    } else {
      process.stdout.write(
        `${status.ok(`Submitted "${item.title}" for review`)} ${C.faded}(${item.review_item_id})${C.reset}\n`,
      );
    }
    return 0;
  }

  const verdictExit: Record<string, number> = {
    approved: 0,
    done: 0,
    changes_requested: 3,
    rejected: 4,
    dismissed: 4,
  };
  const deadline = awaitTimeoutSec !== undefined ? Date.now() + awaitTimeoutSec * 1000 : undefined;
  if (!json) {
    process.stderr.write(`${status.ok(`Submitted "${item.title}"`)} — waiting for a human verdict…\n`);
  }
  for (;;) {
    if (deadline !== undefined && Date.now() >= deadline) {
      if (!json) process.stderr.write(`${status.err('Timed out waiting — the item stays open for review.')}\n`);
      else emitJson(item);
      return 5;
    }
    await new Promise((r) => setTimeout(r, AWAIT_POLL_MS));
    try {
      const resp = await ctx.client.get<{ review_item: ReviewItemResponse }>(
        `/projects/${ctx.projectId}/review/items/${item.review_item_id}`,
      );
      item = resp.review_item;
    } catch {
      continue; // transient — keep waiting
    }
    const exit = verdictExit[item.status];
    if (exit !== undefined) {
      if (json) {
        emitJson(item);
      } else {
        const line =
          exit === 0
            ? status.ok(`Approved${item.feedback ? ` — ${item.feedback}` : ''}`)
            : status.err(`${item.status.replace('_', ' ')}${item.feedback ? ` — ${item.feedback}` : ''}`);
        process.stdout.write(`${line}\n`);
      }
      return exit;
    }
  }
}

/**
 * Commit the attached files on the current branch, push, and return the git
 * detail payload — or an exit code when something is wrong locally.
 */
function pinAttachments(paths: string[]): Record<string, unknown> | number {
  let repoRoot: string;
  try {
    repoRoot = git(['rev-parse', '--show-toplevel']);
  } catch {
    process.stderr.write(`${status.err('Not inside a git repository — --attach needs the project workspace.')}\n`);
    return 1;
  }
  let branch: string;
  try {
    branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  } catch {
    branch = 'HEAD';
  }
  if (!branch || branch === 'HEAD') {
    process.stderr.write(`${status.err('Detached HEAD — check out a branch before submitting attachments.')}\n`);
    return 1;
  }

  const files: Array<{ path: string; kind: string; bytes: number }> = [];
  const repoRelative: string[] = [];
  for (const raw of paths) {
    const abs = resolve(raw);
    let bytes: number;
    try {
      const stat = statSync(abs);
      if (!stat.isFile()) {
        process.stderr.write(`${status.err(`Not a file: ${raw} (attach files, not directories)`)}\n`);
        return 1;
      }
      bytes = stat.size;
    } catch {
      process.stderr.write(`${status.err(`File not found: ${raw}`)}\n`);
      return 1;
    }
    if (bytes > MAX_FILE_BYTES) {
      process.stderr.write(
        `${status.err(`${raw} is ${(bytes / (1024 * 1024)).toFixed(1)}MB — over the 25MB per-file cap.`)}\n`,
      );
      return 1;
    }
    const rel = relative(repoRoot, abs).split('\\').join('/');
    if (!rel || rel.startsWith('..')) {
      process.stderr.write(`${status.err(`${raw} is outside the repository at ${repoRoot}.`)}\n`);
      return 1;
    }
    repoRelative.push(rel);
    files.push({ path: rel, kind: fileKind(rel), bytes });
  }

  try {
    git(['add', '--', ...repoRelative], repoRoot);
  } catch (err) {
    process.stderr.write(`${status.err(`git add failed: ${(err as Error).message}`)}\n`);
    return 1;
  }
  const hasStaged = !gitOk(['diff', '--cached', '--quiet', '--', ...repoRelative], repoRoot);
  if (hasStaged) {
    try {
      git(['commit', '-m', `chore(submit): attach ${files.length} file(s) for review`, '--', ...repoRelative], repoRoot);
    } catch (err) {
      process.stderr.write(`${status.err(`git commit failed: ${(err as Error).message}`)}\n`);
      return 1;
    }
  } else {
    // Nothing new to commit — the attachments must already be tracked at HEAD.
    for (const rel of repoRelative) {
      if (!gitOk(['cat-file', '-e', `HEAD:${rel}`], repoRoot)) {
        process.stderr.write(`${status.err(`${rel} has no committed content to submit.`)}\n`);
        return 1;
      }
    }
  }
  try {
    git(['push', 'origin', `HEAD:refs/heads/${branch}`], repoRoot);
  } catch (err) {
    process.stderr.write(`${status.err(`git push failed: ${(err as Error).message}`)}\n`);
    return 1;
  }
  const sha = git(['rev-parse', 'HEAD'], repoRoot);
  return { commit_sha: sha, branch, files };
}
