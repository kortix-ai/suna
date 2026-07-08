// kortix submit — the standardized work-submission verb. Records a session's
// finished output as a review item (Review Center kind: output): artifacts are
// committed on the current branch, pushed, and pinned server-side under a
// keep-ref (refs/kortix/submissions/<id>) so they outlive the sandbox; small
// text results go inline with no files at all. `show` presents, `submit`
// records — anything a human should review or keep gets submitted.

import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { emitJson, resolveProjectContext, surfaceApiError, takeFlagBool, takeFlagValue } from '../command-helpers.ts';
import { sandboxEnvValue } from '../api/sandbox-env.ts';
import { C, status } from '../style.ts';

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const AWAIT_POLL_MS = 5_000;

const HELP = `Usage: kortix submit --title "<text>" [options]

Submit finished work for human review in the project's Review Center. With
--artifact, the named files are committed on the current branch, pushed, and
pinned so they survive the sandbox; with --content, a small text result is
submitted inline with no files.

Options:
  --title "<text>"        Required. Plain-language name for the work.
  --summary "<text>"      One-line description shown in the inbox.
  --artifact <path>       File to submit (repeatable). Committed + pushed.
  --content "<text>"      Inline text result (mutually exclusive w/ --artifact).
  --claim "<text>"        Checkable statement about the work (repeatable).
  --kind <label>          Artifact kind label (report, document, image, …).
  --risk none|low|medium|high   Reviewer triage hint. Default: none.
  --await                 Block until a human verdict; exit code reflects it
                          (0 approved/done, 3 changes requested, 4 rejected).
  --await-timeout <sec>   Give up waiting after this many seconds (default: no
                          timeout). Exit 5 on timeout; the item stays open.
  --json                  Print the review item as JSON.

Global options:
  --project <id>     Operate on this project id (default: linked).
  --host <name>      Operate against a non-default Kortix host.
  -h, --help         Show this help.

Inside an agent sandbox the CLI reads KORTIX_CLI_TOKEN and KORTIX_PROJECT_ID
from the environment automatically — you don't need to log in or link.
(KORTIX_TOKEN is the sandbox service key, not a CLI token.)
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
  let summary: string | undefined;
  let content: string | undefined;
  let artifactKind: string | undefined;
  let risk: string | undefined;
  let projectFlag: string | undefined;
  let hostFlag: string | undefined;
  let awaitVerdict = false;
  let awaitTimeoutRaw: string | undefined;
  let json = false;
  const artifacts: string[] = [];
  const claims: string[] = [];
  try {
    title = takeFlagValue(rest, ['--title']);
    summary = takeFlagValue(rest, ['--summary']);
    content = takeFlagValue(rest, ['--content']);
    artifactKind = takeFlagValue(rest, ['--kind']);
    risk = takeFlagValue(rest, ['--risk']);
    projectFlag = takeFlagValue(rest, ['--project']);
    hostFlag = takeFlagValue(rest, ['--host']);
    awaitVerdict = takeFlagBool(rest, ['--await']);
    awaitTimeoutRaw = takeFlagValue(rest, ['--await-timeout']);
    json = takeFlagBool(rest, ['--json']);
    // Repeatable flags — drain until absent.
    for (;;) {
      const a = takeFlagValue(rest, ['--artifact']);
      if (a === undefined) break;
      artifacts.push(a);
    }
    for (;;) {
      const cl = takeFlagValue(rest, ['--claim']);
      if (cl === undefined) break;
      claims.push(cl);
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
  if (artifacts.length > 0 && content !== undefined) {
    process.stderr.write(`${status.err('--artifact and --content are mutually exclusive.')}\n`);
    return 2;
  }
  if (artifacts.length === 0 && !content?.trim()) {
    process.stderr.write(`${status.err('Pass at least one --artifact, or --content for an inline result.')}\n`);
    return 2;
  }
  const awaitTimeoutSec = awaitTimeoutRaw !== undefined ? Number(awaitTimeoutRaw) : undefined;
  if (awaitTimeoutSec !== undefined && (!Number.isFinite(awaitTimeoutSec) || awaitTimeoutSec <= 0)) {
    process.stderr.write(`${status.err('--await-timeout must be a positive number of seconds.')}\n`);
    return 2;
  }

  const ctx = await resolveProjectContext({ projectArg: projectFlag, hostArg: hostFlag });
  if (!ctx) return 1;

  const detail: Record<string, unknown> = { submission_version: 1 };
  if (artifactKind?.trim()) detail.artifact_kind = artifactKind.trim();
  if (claims.length > 0) detail.claims = claims;

  if (artifacts.length > 0) {
    const pinned = pinArtifacts(artifacts);
    if (typeof pinned === 'number') return pinned;
    detail.storage = 'git';
    detail.git = pinned;
  } else {
    detail.storage = 'inline';
    detail.content = content;
  }

  const body: Record<string, unknown> = {
    kind: 'output',
    title: title.trim(),
    ...(summary?.trim() ? { summary: summary.trim() } : {}),
    ...(risk ? { risk } : {}),
    detail,
  };
  const sessionId = sandboxEnvValue('KORTIX_SESSION_ID');
  if (sessionId) body.session_id = sessionId;

  let item: ReviewItemResponse;
  try {
    item = await ctx.client.post<ReviewItemResponse>(`/projects/${ctx.projectId}/review/items`, body);
  } catch (err) {
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
 * Commit the named files on the current branch, push, and return the git
 * detail payload — or an exit code when something is wrong locally.
 */
function pinArtifacts(paths: string[]): Record<string, unknown> | number {
  let repoRoot: string;
  try {
    repoRoot = git(['rev-parse', '--show-toplevel']);
  } catch {
    process.stderr.write(`${status.err('Not inside a git repository — --artifact needs the project workspace.')}\n`);
    return 1;
  }
  let branch: string;
  try {
    branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  } catch {
    branch = 'HEAD';
  }
  if (!branch || branch === 'HEAD') {
    process.stderr.write(`${status.err('Detached HEAD — check out a branch before submitting artifacts.')}\n`);
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
        process.stderr.write(`${status.err(`Not a file: ${raw} (submit files, not directories)`)}\n`);
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
      git(['commit', '-m', `chore(submit): pin ${files.length} artifact(s) for review`, '--', ...repoRelative], repoRoot);
    } catch (err) {
      process.stderr.write(`${status.err(`git commit failed: ${(err as Error).message}`)}\n`);
      return 1;
    }
  } else {
    // Nothing new to commit — the artifacts must already be tracked at HEAD.
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
