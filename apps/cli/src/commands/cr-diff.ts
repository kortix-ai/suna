import type { ApiClient } from '../api/client.ts';
import type {
  ChangeRequest,
  ChangeRequestDetailResponse,
  ChangeRequestDiffResponse,
  ChangeRequestMergePreview,
  ChangeRequestsListResponse,
} from '../api/types.ts';
import {
  emitJson,
  fail,
  missing,
  resolveProjectContext,
  surfaceApiError,
  takeFlagBool,
  takeFlagValue,
} from '../command-helpers.ts';
import { UUID_RE } from '../iam.ts';
import { C, pad, status } from '../style.ts';

// `kortix cr` — the diff surfaces, plus the plumbing every CR verb shares.
//
// `cr diff` and `cr version-diff` render what merging would change, with a
// CR or without one. They live next to `resolveCr` (a `<cr>` number/uuid →
// the live row) and `displayBranch` (a branch ref → display form) because
// those two are shared by the verbs that stay in cr.ts; one home here keeps
// cr.ts to the verbs themselves.

export type CtxOpts = { projectArg?: string; hostArg?: string };

/** GET /projects/:id/version-diff — a summary, no patch body. */
interface VersionDiffPreview {
  from: string;
  into: string;
  from_sha: string | null;
  into_sha: string | null;
  merge_base: string | null;
  files_changed: number;
  additions: number;
  deletions: number;
  is_up_to_date: boolean;
  is_same_ref: boolean;
}

/**
 * The three merge verdicts, rendered identically by `show` and
 * `merge-preview`. Each verdict ends with a blank line.
 */
export function printMergeVerdict(preview: ChangeRequestMergePreview): void {
  if (preview.is_up_to_date) {
    process.stdout.write(`  ${C.dim}Already at base — nothing to merge.${C.reset}\n\n`);
  } else if (preview.can_merge) {
    process.stdout.write(
      `  ${C.green}✓${C.reset} Mergeable cleanly${preview.can_fast_forward ? ' (fast-forward)' : ''}.\n\n`,
    );
  } else {
    process.stdout.write(
      `  ${C.yellow}⚠${C.reset} Conflicts in ${preview.conflicts.length} file${preview.conflicts.length === 1 ? '' : 's'}:\n`,
    );
    for (const path of preview.conflicts) {
      process.stdout.write(`    ${C.faded}${path}${C.reset}\n`);
    }
    process.stdout.write('\n');
  }
}

export function displayBranch(name: string): string {
  return UUID_RE.test(name) ? `${name.slice(0, 8)}…` : name;
}

/**
 * Resolve a user-supplied CR reference (`3` or a uuid) to the live CR row.
 * Always lists once so we can match a numeric reference; cheap enough for
 * v1, and it gives us a single error path.
 */
export async function resolveCr(
  ctx: { client: ApiClient; projectId: string },
  ref: string | undefined,
): Promise<ChangeRequest | null> {
  if (!ref) {
    process.stderr.write(`${status.err('Pass a CR number or uuid.')}\n`);
    return null;
  }
  if (UUID_RE.test(ref)) {
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

export async function crDiff(argv: string[], opts: CtxOpts, json = false): Promise<number> {
  const noColor = takeFlagBool(argv, ['--no-color']);
  const ctx = await resolveProjectContext(opts);
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

  if (json) {
    emitJson({ cr, patch: diff.patch });
    return 0;
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

/**
 * Diff two versions WITHOUT a CR — the same summary the dashboard's "Open
 * change request" dialog shows live, so a caller can tell whether there is
 * anything to propose before it opens one.
 */
export async function crVersionDiff(argv: string[], opts: CtxOpts, json = false): Promise<number> {
  let fromRef: string | undefined;
  let intoRef: string | undefined;
  try {
    fromRef = takeFlagValue(argv, ['--from', '--head']);
    intoRef = takeFlagValue(argv, ['--into', '--base']);
  } catch (err) {
    return fail((err as Error).message);
  }
  if (!fromRef) fromRef = process.env.KORTIX_BRANCH_NAME || process.env.KORTIX_HEAD_REF;
  if (!fromRef || !intoRef) return missing('--from <version> and --into <version>');

  const ctx = await resolveProjectContext(opts);
  if (!ctx) return 1;

  const params = new URLSearchParams({ from: fromRef, into: intoRef });
  let diff: VersionDiffPreview;
  try {
    diff = await ctx.client.get<VersionDiffPreview>(
      `/projects/${ctx.projectId}/version-diff?${params.toString()}`,
    );
  } catch (err) {
    return surfaceApiError(err);
  }

  if (json) {
    emitJson(diff);
    return 0;
  }
  process.stdout.write('\n');
  process.stdout.write(`  ${displayBranch(diff.from)} → ${displayBranch(diff.into)}\n`);
  if (diff.is_same_ref) {
    process.stdout.write(`  ${C.dim}Same version — nothing to compare.${C.reset}\n\n`);
    return 0;
  }
  if (diff.is_up_to_date || diff.files_changed === 0) {
    process.stdout.write(`  ${C.dim}No changes — nothing to propose.${C.reset}\n\n`);
    return 0;
  }
  process.stdout.write(
    `  ${diff.files_changed} file${diff.files_changed === 1 ? '' : 's'},` +
      ` ${C.green}+${diff.additions}${C.reset} ${C.red}-${diff.deletions}${C.reset}\n\n`,
  );
  return 0;
}
