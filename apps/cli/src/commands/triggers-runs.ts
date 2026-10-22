import { readFileSync } from 'node:fs';
import type { TriggerDryRunResponse, TriggerFireResponse, TriggerRun, TriggerRunList } from '../api/types.ts';
import {
  type CtxOpts,
  emitJson,
  fail,
  missing,
  query,
  resolveProjectContext,
  surfaceApiError,
} from '../command-helpers.ts';
import { C, pad, status } from '../style.ts';

const RUN_STATUSES = ['queued', 'running', 'fired', 'failed', 'skipped', 'rejected'];

/** `--payload` is inline JSON or `@path/to/file.json`; it must be a JSON object. */
export function parsePayloadFlag(
  raw: string,
): { value: Record<string, unknown> } | { error: string } {
  let text = raw;
  if (raw.startsWith('@')) {
    try {
      text = readFileSync(raw.slice(1), 'utf8');
    } catch (err) {
      return { error: `--payload: cannot read ${raw.slice(1)} (${(err as Error).message})` };
    }
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    return { error: `--payload is not valid JSON (${(err as Error).message})` };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { error: '--payload must be a JSON object, e.g. \'{"body":{"ticket":"T-1"}}\'' };
  }
  return { value: value as Record<string, unknown> };
}

function errorCode(err: unknown): unknown {
  return (err as { body?: { code?: unknown } })?.body?.code;
}

/** `triggers fire <slug> --dry-run`: render the fire, write nothing. */
export async function triggersDryRun(
  slug: string | undefined,
  payload: Record<string, unknown> | undefined,
  opts: CtxOpts,
  json: boolean,
): Promise<number> {
  if (!slug) return missing('a trigger slug');
  const ctx = await resolveProjectContext(opts);
  if (!ctx) return 1;
  let resp: TriggerDryRunResponse;
  try {
    resp = await ctx.client.post<TriggerDryRunResponse>(
      `/projects/${ctx.projectId}/triggers/${encodeURIComponent(slug)}/fire`,
      { dry_run: true, ...(payload ? { payload } : {}) },
    );
  } catch (err) {
    return surfaceApiError(err);
  }
  if (json) {
    emitJson(resp);
    return 0;
  }
  const verdict = resp.filter_matches
    ? `${C.green}matches${C.reset}`
    : `${C.yellow}does not match — a real fire is skipped${C.reset}`;
  process.stdout.write(
    `\n  ${C.bold}Dry run of ${slug}${C.reset} ${C.dim}— nothing was fired or written${C.reset}\n` +
      `  ${C.dim}filter      ${C.reset}${verdict}\n` +
      `  ${C.dim}session key ${C.reset}${resp.session_key ?? '—'}\n` +
      `  ${C.dim}prompt${C.reset}\n${resp.rendered_prompt
        .split('\n')
        .map((l) => `    ${l}`)
        .join('\n')}\n\n`,
  );
  return 0;
}

function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function formatCost(usd: number | null): string {
  if (usd === null) return '—';
  return `$${usd.toFixed(usd > 0 && usd < 0.01 ? 4 : 2)}`;
}

function statusColor(s: string): string {
  if (s === 'failed' || s === 'rejected') return C.red;
  if (s === 'fired' || s === 'succeeded') return C.green;
  if (s === 'skipped') return C.faded;
  return C.yellow;
}

/** `triggers runs <slug>`: the trigger's run history, newest first. */
export async function triggersRuns(
  slug: string | undefined,
  f: { status?: string; limit?: string; cursor?: string },
  opts: CtxOpts,
  json: boolean,
): Promise<number> {
  if (!slug) return missing('a trigger slug');
  if (f.status && !RUN_STATUSES.includes(f.status)) {
    return fail(`Unknown --status "${f.status}". Use ${RUN_STATUSES.join(', ')}.`);
  }
  const limit = f.limit === undefined ? undefined : Number(f.limit);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) {
    return fail(`--limit must be an integer from 1 to 100 (got "${f.limit}")`);
  }
  const ctx = await resolveProjectContext(opts);
  if (!ctx) return 1;
  let resp: TriggerRunList;
  try {
    resp = await ctx.client.get<TriggerRunList>(
      `/projects/${ctx.projectId}/triggers/${encodeURIComponent(slug)}/runs${query({
        limit,
        status: f.status,
        cursor: f.cursor,
      })}`,
    );
  } catch (err) {
    return surfaceApiError(err);
  }
  if (json) {
    emitJson(resp);
    return 0;
  }
  // A page can be empty and still have older runs: the server drops runs the caller may not see.
  const more = resp.next_cursor ? ` — older runs: --cursor ${resp.next_cursor}` : '';
  if (resp.runs.length === 0) {
    process.stdout.write(`  ${C.dim}No runs of ${slug}${f.status ? ` with status ${f.status}` : ''} on this page${more}.${C.reset}\n`);
    return 0;
  }
  const rows = resp.runs.map((r: TriggerRun) => [
    r.run_id,
    new Date(r.started_at).toLocaleString(),
    r.replay_of ? `${r.source} (replay)` : r.source,
    r.status,
    r.run_status ?? '—',
    formatDuration(r.duration_ms),
    formatCost(r.cost_usd),
    r.session_id ?? '—',
  ]);
  const head = ['RUN', 'STARTED', 'SOURCE', 'STATUS', 'RUN STATUS', 'DURATION', 'COST', 'SESSION'];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i]!.length)));
  const line = (cells: string[], color = true) =>
    `  ${cells
      .map((c, i) => {
        const cell = i === cells.length - 1 ? c : pad(c, widths[i]!);
        return color && (i === 3 || i === 4) && c !== '—' ? `${statusColor(c)}${cell}${C.reset}` : cell;
      })
      .join('   ')}\n`;
  process.stdout.write(`\n  ${C.dim}${line(head, false).trim()}${C.reset}\n`);
  rows.forEach((row) => process.stdout.write(line(row)));
  for (const r of resp.runs) {
    if (r.error || r.run_error) {
      process.stdout.write(`  ${C.dim}${r.run_id}:${C.reset} ${C.red}${r.error ?? r.run_error}${C.reset}\n`);
    }
  }
  process.stdout.write(
    `\n  ${C.dim}${resp.runs.length} run${resp.runs.length === 1 ? '' : 's'}${more}${C.reset}\n\n`,
  );
  return 0;
}

/** `triggers replay <slug> <run_id>`: fire the trigger again with that run's stored payload. */
export async function triggersReplay(
  slug: string | undefined,
  runId: string | undefined,
  confirmUnverified: boolean,
  opts: CtxOpts,
  json: boolean,
): Promise<number> {
  if (!slug) return missing('a trigger slug');
  if (!runId) return missing('a run id (`kortix triggers runs <slug>` lists them)');
  const ctx = await resolveProjectContext(opts);
  if (!ctx) return 1;
  let resp: TriggerFireResponse;
  try {
    resp = await ctx.client.post<TriggerFireResponse>(
      `/projects/${ctx.projectId}/triggers/${encodeURIComponent(slug)}/runs/${encodeURIComponent(runId)}/replay`,
      confirmUnverified ? { confirm_unverified: true } : {},
    );
  } catch (err) {
    const code = errorCode(err);
    if (code === 'payload_unverified') {
      process.stderr.write(
        `${status.err(`Run ${runId} has an unverified payload (its webhook signature did not verify). Replay it anyway with --confirm-unverified.`)}\n`,
      );
      return 1;
    }
    if (code === 'payload_truncated') {
      process.stderr.write(
        `${status.err(`Run ${runId} cannot be replayed: its payload was over 64 KiB and was not stored.`)}\n`,
      );
      return 1;
    }
    if (code === 'run_in_progress') {
      process.stderr.write(`${status.err(`Run ${runId} is still in progress. Replay it after it ends.`)}\n`);
      return 1;
    }
    return surfaceApiError(err);
  }
  if (json) {
    emitJson(resp);
    return 0;
  }
  const verb = resp.status === 'fired' ? 'Replayed' : 'Queued replay of';
  process.stdout.write(
    `${status.ok(`${verb} ${C.bold}${slug}${C.reset} run ${runId}${resp.run_id ? ` → run ${resp.run_id}` : ''}${
      resp.session_id ? ` ${C.dim}session ${resp.session_id}${C.reset}` : ''
    }`)}\n`,
  );
  return 0;
}
