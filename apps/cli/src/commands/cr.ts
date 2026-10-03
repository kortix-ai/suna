import { splitHelp } from '../command-argv.ts';
import {
  emitJson,
  resolveProjectContext,
  surfaceApiError,
  takeFlagBool,
  takeFlagValue,
  fail,
  missing,
} from '../command-helpers.ts';
import { C, help, pad, status } from '../style.ts';
import type {
  ChangeRequest,
  ChangeRequestDiffResponse,
  ChangeRequestMergePreview,
  ChangeRequestMergeResponse,
  ChangeRequestsListResponse,
  ChangeRequestStatus,
} from '../api/types.ts';
import { crDiff, crVersionDiff, displayBranch, printMergeVerdict, resolveCr, type CtxOpts } from './cr-diff.ts';

const HELP = help`Usage: kortix cr <subcommand> [options]

Open, review, and merge Kortix change requests. A CR proposes merging one
version (branch) into another inside a project. The CR layer is Kortix-
native — it works on top of any git host (GitHub, GitLab, plain
git) without a per-host adapter.

Subcommands:
  ls [--status open|merged|closed|all]   List CRs. Default: open.
     [--json]                            Print the raw CR list as JSON.
  show <cr> [--json]                     Show one CR's metadata.
  diff <cr> [--no-color] [--json]        Show the CR's unified diff.
  open --head <ver> [--base <ver>]       Open a new CR.
       --title "<text>" [--description "<text>"]
  merge <cr> [--message "<text>"]        Merge an open CR into its base.
  merge-preview <cr> [--json]            Can it merge? Lists any conflicts.
  request-changes <cr> --message "<t>"   Ask the agent that opened it to revise.
  close <cr>                             Close an open CR without merging.
  reopen <cr>                            Reopen a closed CR.
  version-diff --from <head> --into <base> Summarize what merging <head> into <base>
                [--json]                 before opening a CR.

<cr> can be a CR number (e.g. 3) or a CR uuid.

request-changes records the note on the CR and delivers it to the originating
session, booting its sandbox if it is asleep. It needs project.review.act —
the same leaf the Review Center uses, not gitops.push.

Global options:
  --project <id>     Operate on this project id (default: linked).
  --host <name>      Operate against a non-default Kortix host.
  -h, --help         Show this help.

Inside an agent sandbox the CLI reads KORTIX_TOKEN and KORTIX_PROJECT_ID
from the environment automatically — you don't need to log in or link.
(KORTIX_TOKEN is the sandbox service key, not a CLI token.)
`;

export async function runCr(argv: string[]): Promise<number> {
  const helpCode = splitHelp(argv, HELP);
  if (helpCode !== null) return helpCode;

  const sub = argv[0];
  const rest = argv.slice(1);
  let projectFlag: string | undefined;
  let hostFlag: string | undefined;
  let json = false;
  try {
    projectFlag = takeFlagValue(rest, ['--project']);
    hostFlag = takeFlagValue(rest, ['--host']);
    json = takeFlagBool(rest, ['--json']);
  } catch (err) {
    return fail((err as Error).message);
  }
  const ctxOpts: CtxOpts = { projectArg: projectFlag, hostArg: hostFlag };

  switch (sub) {
    case 'ls':
    case 'list':
      return crLs(rest, ctxOpts, json);
    case 'show':
    case 'info':
      return crShow(rest[0], ctxOpts, json);
    case 'diff':
      return crDiff(rest, ctxOpts, json);
    case 'open':
    case 'new':
    case 'create':
      return crOpen(rest, ctxOpts);
    case 'merge':
      return crMerge(rest, ctxOpts);
    case 'merge-preview':
    case 'preview':
      return crMergePreview(rest[0], ctxOpts, json);
    case 'request-changes':
    case 'changes':
      return crRequestChanges(rest, ctxOpts, json);
    case 'version-diff':
      return crVersionDiff(rest, ctxOpts, json);
    case 'close':
      return crClose(rest[0], ctxOpts);
    case 'reopen':
      return crReopen(rest[0], ctxOpts);
    default:
      process.stderr.write(`${status.err(`unknown subcommand "${sub}"`)}\n\n${HELP}`);
      return 2;
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

function statusBadge(s: ChangeRequestStatus): string {
  if (s === 'open') return `${C.green}● open${C.reset}`;
  if (s === 'merged') return `${C.cyan}✔ merged${C.reset}`;
  return `${C.faded}× closed${C.reset}`;
}

function relativeTime(iso: string): string {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

// ── subcommands ────────────────────────────────────────────────────────────

async function crLs(argv: string[], opts: CtxOpts, json = false): Promise<number> {
  let statusFilter: string | undefined;
  try {
    statusFilter = takeFlagValue(argv, ['--status']);
  } catch (err) {
    return fail((err as Error).message);
  }
  const filter = (statusFilter ?? 'open').toLowerCase();
  if (!['open', 'merged', 'closed', 'all'].includes(filter)) return fail('--status must be open|merged|closed|all');

  const ctx = await resolveProjectContext(opts);
  if (!ctx) return 1;

  let resp: ChangeRequestsListResponse;
  try {
    resp = await ctx.client.get<ChangeRequestsListResponse>(
      `/projects/${ctx.projectId}/change-requests?status=${filter}`,
    );
  } catch (err) {
    return surfaceApiError(err);
  }

  if (json) {
    emitJson(resp);
    return 0;
  }

  const crs = resp.change_requests;
  if (crs.length === 0) {
    process.stdout.write(
      `  ${C.dim}No ${filter === 'all' ? '' : filter + ' '}change requests${C.reset}\n`,
    );
    return 0;
  }

  const numW = Math.max(...crs.map((c) => `#${c.number}`.length), 3);
  const statusW = 10; // "× closed", "● open", "✔ merged" all fit
  const headBaseStrs = crs.map(
    (c) => `${displayBranch(c.head_ref)} → ${displayBranch(c.base_ref)}`,
  );
  const branchW = Math.min(Math.max(...headBaseStrs.map((s) => s.length), 12), 48);

  process.stdout.write('\n');
  process.stdout.write(
    `  ${C.dim}${pad('#', numW)}  ${pad('STATUS', statusW)}  ${pad('FROM → INTO', branchW)}  TITLE${C.reset}\n`,
  );
  for (let i = 0; i < crs.length; i += 1) {
    const cr = crs[i];
    process.stdout.write(
      `  ${pad(`#${cr.number}`, numW)}  ${pad(statusBadge(cr.status), statusW)}  ${pad(headBaseStrs[i], branchW)}  ${cr.title}\n`,
    );
  }
  process.stdout.write(
    `\n  ${C.dim}${crs.length} change request${crs.length === 1 ? '' : 's'}${C.reset}\n\n`,
  );
  return 0;
}

async function crShow(ref: string | undefined, opts: CtxOpts, json = false): Promise<number> {
  const ctx = await resolveProjectContext(opts);
  if (!ctx) return 1;
  const cr = await resolveCr(ctx, ref);
  if (!cr) return 1;

  if (json) {
    let merge_preview: ChangeRequestMergePreview | null = null;
    if (cr.status === 'open') {
      try {
        merge_preview = await ctx.client.get<ChangeRequestMergePreview>(
          `/projects/${ctx.projectId}/change-requests/${cr.cr_id}/merge-preview`,
        );
      } catch {
        merge_preview = null;
      }
    }
    emitJson({ change_request: cr, merge_preview });
    return 0;
  }

  process.stdout.write('\n');
  process.stdout.write(`  ${C.bold}#${cr.number}${C.reset}  ${cr.title}\n`);
  process.stdout.write(`  ${statusBadge(cr.status)}\n\n`);
  if (cr.description) {
    process.stdout.write(`  ${cr.description.replace(/\n/g, '\n  ')}\n\n`);
  }
  const head = displayBranch(cr.head_ref);
  const base = displayBranch(cr.base_ref);
  const headSha = cr.head_commit_sha ? cr.head_commit_sha.slice(0, 7) : '';
  process.stdout.write(`  ${C.dim}Head ${C.reset}${head}${headSha ? `  ${C.faded}${headSha}${C.reset}` : ''}\n`);
  process.stdout.write(`  ${C.dim}Base ${C.reset}${base}\n`);
  process.stdout.write(`  ${C.dim}Opened ${C.reset}${relativeTime(cr.created_at)}\n`);
  if (cr.merged_at) {
    const m = cr.merge_commit_sha?.slice(0, 7);
    process.stdout.write(`  ${C.dim}Merged ${C.reset}${relativeTime(cr.merged_at)}${m ? `  ${C.faded}${m}${C.reset}` : ''}\n`);
  }
  if (cr.closed_at && cr.status === 'closed') {
    process.stdout.write(`  ${C.dim}Closed ${C.reset}${relativeTime(cr.closed_at)}\n`);
  }
  process.stdout.write('\n');

  if (cr.status === 'open') {
    try {
      const preview = await ctx.client.get<ChangeRequestMergePreview>(
        `/projects/${ctx.projectId}/change-requests/${cr.cr_id}/merge-preview`,
      );
      printMergeVerdict(preview);
    } catch (err) {
      // Surface but don't block the rest of show.
      const message = (err as Error).message;
      process.stdout.write(`  ${C.dim}(merge preview unavailable: ${message})${C.reset}\n\n`);
    }
  }

  return 0;
}

async function crOpen(argv: string[], opts: CtxOpts): Promise<number> {
  let headRef: string | undefined;
  let baseRef: string | undefined;
  let title: string | undefined;
  let description: string | undefined;
  let sessionId: string | undefined;
  try {
    headRef = takeFlagValue(argv, ['--head', '--from']);
    baseRef = takeFlagValue(argv, ['--base', '--into']);
    title = takeFlagValue(argv, ['--title', '-t']);
    description = takeFlagValue(argv, ['--description', '--body']);
    sessionId = takeFlagValue(argv, ['--session']);
  } catch (err) {
    return fail((err as Error).message);
  }

  // Inside a sandbox the agent already knows the branch and session it's on.
  // Fall back to those env vars so `kortix cr open --title "..."` from inside
  // a session JUST WORKS.
  if (!headRef) headRef = process.env.KORTIX_BRANCH_NAME || process.env.KORTIX_HEAD_REF;
  if (!sessionId) sessionId = process.env.KORTIX_SESSION_ID;

  if (!headRef) return fail('--head <version> is required (or set KORTIX_BRANCH_NAME).');
  if (!title) return fail('--title "<text>" is required.');

  const ctx = await resolveProjectContext(opts);
  if (!ctx) return 1;

  const body: Record<string, unknown> = {
    head_ref: headRef,
    title,
  };
  if (baseRef) body.base_ref = baseRef;
  if (description) body.description = description;
  if (sessionId) body.session_id = sessionId;

  let created: ChangeRequest;
  try {
    created = await ctx.client.post<ChangeRequest>(
      `/projects/${ctx.projectId}/change-requests`,
      body,
    );
  } catch (err) {
    return surfaceApiError(err);
  }

  process.stdout.write(
    `\n  ${C.green}✓${C.reset} Opened ${C.bold}CR #${created.number}${C.reset}: ${created.title}\n`,
  );
  process.stdout.write(
    `  ${C.dim}${displayBranch(created.head_ref)} → ${displayBranch(created.base_ref)}${C.reset}\n\n`,
  );

  // A CR whose head tip equals base shows "No changes detected" in the
  // dashboard and can't be applied — by far the most common cause is a
  // committed-but-never-pushed session branch. Catch it here, at open time,
  // while the author (usually an agent) can still fix it in one command. The
  // diff endpoint recomputes live, so pushing after this warning heals the
  // SAME CR — no need to reopen. Best-effort: never fail the open over it.
  try {
    const diff = await ctx.client.get<ChangeRequestDiffResponse>(
      `/projects/${ctx.projectId}/change-requests/${created.cr_id}/diff`,
    );
    if (diff.files_changed === 0) {
      process.stderr.write(
        `  ${C.yellow}⚠${C.reset} CR #${created.number} has NO changes — its head branch is identical to ${displayBranch(created.base_ref)}.\n    If you committed locally, push first: ${C.bold}git push origin HEAD${C.reset}\n    The CR updates automatically once the push lands.\n\n`,
      );
    }
  } catch {
    // Diff unavailable (e.g. transient mirror refresh) — the open succeeded,
    // don't fail or confuse the caller over a advisory check.
  }
  return 0;
}

async function crMerge(argv: string[], opts: CtxOpts): Promise<number> {
  let message: string | undefined;
  try {
    message = takeFlagValue(argv, ['--message', '-m']);
  } catch (err) {
    return fail((err as Error).message);
  }
  const ctx = await resolveProjectContext(opts);
  if (!ctx) return 1;
  const cr = await resolveCr(ctx, argv[0]);
  if (!cr) return 1;

  let result: ChangeRequestMergeResponse;
  try {
    result = await ctx.client.post<ChangeRequestMergeResponse>(
      `/projects/${ctx.projectId}/change-requests/${cr.cr_id}/merge`,
      message ? { message } : {},
    );
  } catch (err) {
    return surfaceApiError(err);
  }

  const sha = result.merge.merge_commit_sha.slice(0, 7);
  const label = result.merge.fast_forward ? 'fast-forward' : '3-way merge';
  process.stdout.write(
    `\n  ${C.green}✓${C.reset} Merged ${C.bold}CR #${cr.number}${C.reset} ${C.dim}(${label})${C.reset}  ${C.faded}${sha}${C.reset}\n\n`,
  );
  return 0;
}

/**
 * Merge preview, on its own.
 *
 * `show` already prints it for an open CR, but a caller that only wants the
 * verdict — an agent deciding whether to resolve conflicts before it asks a
 * human — should not have to parse a whole panel or opt into `--json` on show.
 */
async function crMergePreview(
  ref: string | undefined,
  opts: CtxOpts,
  json = false,
): Promise<number> {
  const ctx = await resolveProjectContext(opts);
  if (!ctx) return 1;
  const cr = await resolveCr(ctx, ref);
  if (!cr) return 1;

  let preview: ChangeRequestMergePreview;
  try {
    preview = await ctx.client.get<ChangeRequestMergePreview>(
      `/projects/${ctx.projectId}/change-requests/${cr.cr_id}/merge-preview`,
    );
  } catch (err) {
    return surfaceApiError(err);
  }

  if (json) {
    emitJson(preview);
    return 0;
  }

  process.stdout.write('\n');
  process.stdout.write(
    `  ${C.bold}#${cr.number}${C.reset}  ${displayBranch(cr.head_ref)} → ${displayBranch(cr.base_ref)}\n`,
  );
  printMergeVerdict(preview);
  // A conflicted CR cannot be shipped as it stands — say so in the exit code
  // too, so a script can branch on it without reading the text.
  return preview.can_merge || preview.is_up_to_date ? 0 : 1;
}

/**
 * "Request changes" — the human review decision the Review Center sends. It
 * records the note on the CR (CRs have no comment table) and delivers it to
 * the agent that opened the change, which then revises it.
 */
async function crRequestChanges(
  argv: string[],
  opts: CtxOpts,
  json = false,
): Promise<number> {
  let message: string | undefined;
  try {
    message = takeFlagValue(argv, ['--message', '--feedback', '-m']);
  } catch (err) {
    return fail((err as Error).message);
  }
  const feedback = (message ?? '').trim();
  if (!feedback) return missing('--message "<what to change>"');
  const ctx = await resolveProjectContext(opts);
  if (!ctx) return 1;
  const cr = await resolveCr(ctx, argv[0]);
  if (!cr) return 1;

  let resp: { change_request: ChangeRequest; delivering: boolean };
  try {
    resp = await ctx.client.post<{ change_request: ChangeRequest; delivering: boolean }>(
      `/projects/${ctx.projectId}/change-requests/${cr.cr_id}/request-changes`,
      { feedback },
    );
  } catch (err) {
    return surfaceApiError(err);
  }

  if (json) {
    emitJson(resp);
    return 0;
  }
  // `delivering` is the server saying it has an originating session to prompt.
  // Delivery itself is fire-and-forget, so never claim the agent received it.
  process.stdout.write(
    resp.delivering
      ? `${status.ok(`Delivering to the agent — it will revise ${C.bold}CR #${cr.number}${C.reset}`)}\n`
      : `${status.ok(`Saved on ${C.bold}CR #${cr.number}${C.reset}`)} ${C.dim}(no originating session to deliver to)${C.reset}\n`,
  );
  return 0;
}

async function crClose(ref: string | undefined, opts: CtxOpts): Promise<number> {
  const ctx = await resolveProjectContext(opts);
  if (!ctx) return 1;
  const cr = await resolveCr(ctx, ref);
  if (!cr) return 1;

  try {
    await ctx.client.post<ChangeRequest>(
      `/projects/${ctx.projectId}/change-requests/${cr.cr_id}/close`,
      {},
    );
  } catch (err) {
    return surfaceApiError(err);
  }
  process.stdout.write(`\n  ${C.faded}× Closed CR #${cr.number}${C.reset}\n\n`);
  return 0;
}

async function crReopen(ref: string | undefined, opts: CtxOpts): Promise<number> {
  const ctx = await resolveProjectContext(opts);
  if (!ctx) return 1;
  const cr = await resolveCr(ctx, ref);
  if (!cr) return 1;

  try {
    await ctx.client.post<ChangeRequest>(
      `/projects/${ctx.projectId}/change-requests/${cr.cr_id}/reopen`,
      {},
    );
  } catch (err) {
    return surfaceApiError(err);
  }
  process.stdout.write(`\n  ${C.green}● Reopened CR #${cr.number}${C.reset}\n\n`);
  return 0;
}
