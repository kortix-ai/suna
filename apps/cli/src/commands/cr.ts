import { resolveProjectContext, surfaceApiError, takeFlagBool, takeFlagValue } from '../command-helpers.ts';
import { C, pad, status } from '../style.ts';
import type {
  ChangeRequest,
  ChangeRequestDetailResponse,
  ChangeRequestDiffResponse,
  ChangeRequestMergePreview,
  ChangeRequestMergeResponse,
  ChangeRequestStatus,
  ChangeRequestsListResponse,
} from '../api/types.ts';

const HELP = `Usage: kortix cr <subcommand> [options]

Open, review, and merge Kortix change requests. A CR proposes merging one
version (branch) into another inside a project. The CR layer is Kortix-
native — it works on top of any git host (GitHub, GitLab, Freestyle, plain
git) without per-host integration.

Subcommands:
  ls [--status open|merged|closed|all]   List CRs. Default: open.
  show <cr>                              Show one CR's metadata.
  diff <cr> [--no-color]                 Show the CR's unified diff.
  open --head <ver> [--base <ver>]       Open a new CR.
       --title "<text>" [--description "<text>"]
  merge <cr> [--message "<text>"]        Merge an open CR into its base.
  close <cr>                             Close an open CR without merging.
  reopen <cr>                            Reopen a closed CR.

<cr> can be a CR number (e.g. 3) or a CR uuid.

Global options:
  --project <id>     Operate on this project id (default: linked).
  -h, --help         Show this help.

Inside an agent sandbox the CLI reads KORTIX_TOKEN and KORTIX_PROJECT_ID
from the environment automatically — you don't need to log in or link.
`;

export async function runCr(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    process.stdout.write(HELP);
    return argv.length === 0 ? 2 : 0;
  }

  const sub = argv[0];
  const rest = argv.slice(1);
  let projectFlag: string | undefined;
  try {
    projectFlag = takeFlagValue(rest, ['--project']);
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }

  switch (sub) {
    case 'ls':
    case 'list':
      return crLs(rest, projectFlag);
    case 'show':
    case 'info':
      return crShow(rest[0], projectFlag);
    case 'diff':
      return crDiff(rest, projectFlag);
    case 'open':
    case 'new':
    case 'create':
      return crOpen(rest, projectFlag);
    case 'merge':
      return crMerge(rest, projectFlag);
    case 'close':
      return crClose(rest[0], projectFlag);
    case 'reopen':
      return crReopen(rest[0], projectFlag);
    default:
      process.stderr.write(`${status.err(`unknown subcommand "${sub}"`)}\n\n${HELP}`);
      return 2;
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function looksLikeUuid(s: string): boolean {
  return UUID_RE.test(s);
}

function displayBranch(name: string): string {
  return looksLikeUuid(name) ? `${name.slice(0, 8)}…` : name;
}

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

/**
 * Resolve a user-supplied CR reference (`3` or a uuid) to the live CR row.
 * Always lists once so we can match a numeric reference; cheap enough for
 * v1, and it gives us a single error path.
 */
async function resolveCr(
  ctx: { client: import('../api/client.ts').ApiClient; projectId: string },
  ref: string | undefined,
): Promise<ChangeRequest | null> {
  if (!ref) {
    process.stderr.write(`${status.err('Pass a CR number or uuid.')}\n`);
    return null;
  }
  if (looksLikeUuid(ref)) {
    try {
      const resp = await ctx.client.get<ChangeRequestDetailResponse>(
        `/projects/${ctx.projectId}/change-requests/${ref}`,
      );
      return resp.change_request;
    } catch (err) {
      surfaceApiError(err);
      return null;
    }
  }
  const n = Number(ref.replace(/^#/, ''));
  if (!Number.isInteger(n) || n <= 0) {
    process.stderr.write(`${status.err(`"${ref}" is not a valid CR number or uuid.`)}\n`);
    return null;
  }
  try {
    const list = await ctx.client.get<ChangeRequestsListResponse>(
      `/projects/${ctx.projectId}/change-requests?status=all`,
    );
    const match = list.change_requests.find((c) => c.number === n);
    if (!match) {
      process.stderr.write(`${status.err(`No CR #${n} on this project.`)}\n`);
      return null;
    }
    return match;
  } catch (err) {
    surfaceApiError(err);
    return null;
  }
}

// ── subcommands ────────────────────────────────────────────────────────────

async function crLs(argv: string[], projectArg?: string): Promise<number> {
  let statusFilter: string | undefined;
  try {
    statusFilter = takeFlagValue(argv, ['--status']);
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }
  const filter = (statusFilter ?? 'open').toLowerCase();
  if (!['open', 'merged', 'closed', 'all'].includes(filter)) {
    process.stderr.write(`${status.err('--status must be open|merged|closed|all')}\n`);
    return 2;
  }

  const ctx = resolveProjectContext(projectArg);
  if (!ctx) return 1;

  let resp: ChangeRequestsListResponse;
  try {
    resp = await ctx.client.get<ChangeRequestsListResponse>(
      `/projects/${ctx.projectId}/change-requests?status=${filter}`,
    );
  } catch (err) {
    return surfaceApiError(err);
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

async function crShow(ref: string | undefined, projectArg?: string): Promise<number> {
  const ctx = resolveProjectContext(projectArg);
  if (!ctx) return 1;
  const cr = await resolveCr(ctx, ref);
  if (!cr) return 1;

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
      if (preview.is_up_to_date) {
        process.stdout.write(`  ${C.dim}Already at base — nothing to merge.${C.reset}\n`);
      } else if (preview.can_merge) {
        process.stdout.write(
          `  ${C.green}✓${C.reset} Mergeable cleanly${preview.can_fast_forward ? ' (fast-forward)' : ''}.\n`,
        );
      } else {
        process.stdout.write(
          `  ${C.yellow}⚠${C.reset} Conflicts in ${preview.conflicts.length} file${preview.conflicts.length === 1 ? '' : 's'}:\n`,
        );
        for (const p of preview.conflicts) {
          process.stdout.write(`    ${C.faded}${p}${C.reset}\n`);
        }
      }
      process.stdout.write('\n');
    } catch (err) {
      // Surface but don't block the rest of show.
      const message = (err as Error).message;
      process.stdout.write(`  ${C.dim}(merge preview unavailable: ${message})${C.reset}\n\n`);
    }
  }

  return 0;
}

async function crDiff(argv: string[], projectArg?: string): Promise<number> {
  const noColor = takeFlagBool(argv, ['--no-color']);
  const ctx = resolveProjectContext(projectArg);
  if (!ctx) return 1;
  const cr = await resolveCr(ctx, argv[0]);
  if (!cr) return 1;

  let diff: ChangeRequestDiffResponse;
  try {
    diff = await ctx.client.get<ChangeRequestDiffResponse>(
      `/projects/${ctx.projectId}/change-requests/${cr.cr_id}/diff`,
    );
  } catch (err) {
    return surfaceApiError(err);
  }

  if (diff.files_changed === 0) {
    process.stdout.write(`${C.dim}No changes to show.${C.reset}\n`);
    return 0;
  }

  // Files-changed header
  process.stdout.write('\n');
  for (const f of diff.files) {
    const tag =
      f.status === 'added'
        ? `${C.green}+${C.reset}`
        : f.status === 'deleted'
          ? `${C.red}-${C.reset}`
          : `${C.cyan}~${C.reset}`;
    process.stdout.write(
      `  ${tag}  ${pad(f.path, 50)}  ${C.green}+${f.additions}${C.reset} ${C.red}-${f.deletions}${C.reset}\n`,
    );
  }
  process.stdout.write(
    `\n  ${C.dim}${diff.files_changed} file${diff.files_changed === 1 ? '' : 's'},${C.reset} ${C.green}+${diff.additions}${C.reset} ${C.red}-${diff.deletions}${C.reset}\n\n`,
  );

  if (noColor) {
    process.stdout.write(diff.patch);
    return 0;
  }

  // Lightweight terminal coloring for the unified patch
  const useColor = process.stdout.isTTY ?? false;
  if (!useColor) {
    process.stdout.write(diff.patch);
    return 0;
  }
  for (const line of diff.patch.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) {
      process.stdout.write(`${C.bold}${line}${C.reset}\n`);
    } else if (line.startsWith('@@')) {
      process.stdout.write(`${C.cyan}${line}${C.reset}\n`);
    } else if (line.startsWith('+')) {
      process.stdout.write(`${C.green}${line}${C.reset}\n`);
    } else if (line.startsWith('-')) {
      process.stdout.write(`${C.red}${line}${C.reset}\n`);
    } else {
      process.stdout.write(`${line}\n`);
    }
  }
  return 0;
}

async function crOpen(argv: string[], projectArg?: string): Promise<number> {
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
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }

  // Inside a sandbox the agent already knows the branch and session it's on.
  // Fall back to those env vars so `kortix cr open --title "..."` from inside
  // a session JUST WORKS.
  if (!headRef) headRef = process.env.KORTIX_BRANCH_NAME || process.env.KORTIX_HEAD_REF;
  if (!sessionId) sessionId = process.env.KORTIX_SESSION_ID;

  if (!headRef) {
    process.stderr.write(`${status.err('--head <version> is required (or set KORTIX_BRANCH_NAME).')}\n`);
    return 2;
  }
  if (!title) {
    process.stderr.write(`${status.err('--title "<text>" is required.')}\n`);
    return 2;
  }

  const ctx = resolveProjectContext(projectArg);
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
  return 0;
}

async function crMerge(argv: string[], projectArg?: string): Promise<number> {
  let message: string | undefined;
  try {
    message = takeFlagValue(argv, ['--message', '-m']);
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }
  const ctx = resolveProjectContext(projectArg);
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

async function crClose(ref: string | undefined, projectArg?: string): Promise<number> {
  const ctx = resolveProjectContext(projectArg);
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

async function crReopen(ref: string | undefined, projectArg?: string): Promise<number> {
  const ctx = resolveProjectContext(projectArg);
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
