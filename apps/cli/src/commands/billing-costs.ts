import { writeFile } from 'node:fs/promises';
import { type SessionCostSort, fetchCostExportCsv } from '@kortix/sdk';
import { dollarsToCredits, formatCreditsWithSign, formatDollarsAsCredits } from '@kortix/shared';
import { withKortixScope } from '../api/sdk.ts';
import {
  type AccountContext,
  emitJson,
  fail,
  missing,
  query,
  takeFlagValue,
} from '../command-helpers.ts';
import { C, credits, money, pad, status } from '../style.ts';
import type { Flags } from './billing.ts';

const COST_SORTS = ['total_desc', 'total_asc', 'recent', 'name_asc'] as const;

function integer(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${label} requires a positive whole number`);
  return n;
}

function row(label: string, value: string): string {
  return `  ${C.dim}${label}${C.reset}${value}`;
}

// ── Costs ───────────────────────────────────────────────────────────────────

interface CostSummaryView {
  totals: {
    llm_cost: number;
    compute_cost: number;
    total_cost: number;
    request_count: number;
    compute_seconds: number;
    session_count: number;
    project_count: number;
  };
  previous: { total_cost: number };
  models: Array<{ provider: string; model: string; cost: number; request_count: number }>;
}

interface ProjectCostView {
  projects: Array<{
    project_id: string;
    project_name: string;
    session_count: number;
    llm_cost: number;
    compute_cost: number;
    total_cost: number;
  }>;
  total: number;
  limit: number;
  offset: number;
  next_offset: number | null;
}

interface SessionCostView {
  sessions: Array<{
    session_id: string;
    project_name: string;
    owner_name: string | null;
    status: string;
    request_count: number;
    llm_cost: number;
    compute_cost: number;
    total_cost: number;
  }>;
  total: number;
  limit: number;
  offset: number;
  next_offset: number | null;
}

type CostSort = (typeof COST_SORTS)[number];

/** `string` → the COST_SORTS union without a cast; `undefined` when not a member. */
function parseCostSort(raw: string): CostSort | undefined {
  switch (raw) {
    case 'total_desc':
    case 'total_asc':
    case 'recent':
    case 'name_asc':
      return raw;
    default:
      return undefined;
  }
}

export async function costsCommand(ctx: AccountContext, f: Flags): Promise<number> {
  const by = f.by;
  if (by !== undefined && by !== 'project' && by !== 'session') {
    return fail('--by must be project or session');
  }
  const sort = f.sort === undefined ? undefined : parseCostSort(f.sort);
  if (f.sort !== undefined && sort === undefined) {
    return fail(`--sort must be one of ${COST_SORTS.join(', ')}`);
  }
  if (sort === 'name_asc' && by !== 'project') {
    return fail('--sort name_asc is only valid with --by project');
  }
  if (f.csv && !by) {
    return fail('--csv needs --by project or --by session; the account summary has no CSV export');
  }
  const window = { from: f.since, to: f.until };
  const paging = { limit: integer(f.limit, '--limit'), offset: integer(f.offset, '--offset') };

  // `name_asc` was rejected for every non-project roll above, so the sessions
  // CSV arm never carries it — narrowing the union satisfies the SDK's
  // SessionCostSort without a cast.
  const sessionSort: SessionCostSort | undefined = sort === 'name_asc' ? undefined : sort;
  if (f.csv) {
    return costsCsv(
      ctx,
      by === 'project'
        ? {
            kind: 'projects',
            projectId: f.project,
            from: f.since,
            to: f.until,
            sort,
            file: f.csv,
            json: f.json,
          }
        : {
            kind: 'sessions',
            projectId: f.project,
            ownerId: f.owner,
            from: f.since,
            to: f.until,
            sort: sessionSort,
            file: f.csv,
            json: f.json,
          },
    );
  }
  if (by === 'project') {
    return costsByProject(ctx, { projectId: f.project, ...window, sort, ...paging, json: f.json });
  }
  if (by === 'session') {
    return costsBySession(ctx, {
      projectId: f.project,
      ownerId: f.owner,
      ...window,
      sort,
      ...paging,
      json: f.json,
    });
  }
  return costsSummary(ctx, {
    projectId: f.project,
    sessionId: f.session,
    from: f.since,
    to: f.until,
    json: f.json,
  });
}

/** The parts both CSV export kinds share; the discriminated kind adds its own. */
type CostsCsvWindow = {
  projectId?: string;
  from?: string;
  to?: string;
  file: string;
  json: boolean;
};
type CostsCsvOptions =
  | ({ kind: 'projects'; sort?: CostSort } & CostsCsvWindow)
  | ({ kind: 'sessions'; ownerId?: string; sort?: SessionCostSort } & CostsCsvWindow);

async function costsCsv(ctx: AccountContext, o: CostsCsvOptions): Promise<number> {
  // Both CSV routes require a Bearer token, so `fetchCostExportCsv` in the
  // SDK owns the authenticated transport. `x-kortix-row-cap` is the server's
  // row cap — surface it so a truncated finance export is never silent.
  const result = await withKortixScope(ctx.auth, () =>
    o.kind === 'projects'
      ? fetchCostExportCsv('projects', {
          accountId: ctx.accountId,
          projectId: o.projectId,
          from: o.from,
          to: o.to,
          sort: o.sort,
        })
      : fetchCostExportCsv('sessions', {
          accountId: ctx.accountId,
          projectId: o.projectId,
          ownerId: o.ownerId,
          from: o.from,
          to: o.to,
          sort: o.sort,
        }),
  );
  const bytes = new Uint8Array(await result.blob.arrayBuffer());
  await writeFile(o.file, bytes);
  if (o.json) {
    emitJson({ file: o.file, bytes: bytes.byteLength, row_cap: result.rowCap });
    return 0;
  }
  process.stdout.write(`\n  ${status.ok(`wrote ${bytes.byteLength} bytes to ${o.file}`)}\n`);
  if (result.rowCap !== null) {
    process.stdout.write(`  ${C.dim}capped at ${result.rowCap} rows${C.reset}\n`);
  }
  process.stdout.write('\n');
  return 0;
}

async function costsByProject(
  ctx: AccountContext,
  o: {
    projectId?: string;
    from?: string;
    to?: string;
    sort?: CostSort;
    limit?: number;
    offset?: number;
    json: boolean;
  },
): Promise<number> {
  const page = await ctx.client.get<ProjectCostView>(
    `/usage/cost-by-project${query({
      from: o.from,
      to: o.to,
      sort: o.sort,
      limit: o.limit,
      offset: o.offset,
      project_id: o.projectId,
    })}`,
  );
  if (o.json) {
    emitJson(page);
    return 0;
  }
  if (page.projects.length === 0) {
    process.stdout.write(`\n  ${C.dim}No spend in this window.${C.reset}\n\n`);
    return 0;
  }
  const nameW = Math.max(7, ...page.projects.map((p) => p.project_name.length));
  process.stdout.write(
    `\n  ${C.bold}${pad('PROJECT', nameW)}  ${pad('SESSIONS', 8)}  ${pad('LLM', 10)}  ${pad('COMPUTE', 10)}  TOTAL${C.reset}\n`,
  );
  for (const p of page.projects) {
    process.stdout.write(
      `  ${pad(p.project_name, nameW)}  ${pad(String(p.session_count), 8)}  ${pad(money(p.llm_cost), 10)}  ${pad(money(p.compute_cost), 10)}  ${money(p.total_cost)}\n`,
    );
  }
  process.stdout.write(`\n  ${C.dim}${page.projects.length} of ${page.total}${C.reset}\n\n`);
  return 0;
}

async function costsBySession(
  ctx: AccountContext,
  o: {
    projectId?: string;
    ownerId?: string;
    from?: string;
    to?: string;
    sort?: CostSort;
    limit?: number;
    offset?: number;
    json: boolean;
  },
): Promise<number> {
  const page = await ctx.client.get<SessionCostView>(
    `/usage/session-costs${query({
      from: o.from,
      to: o.to,
      sort: o.sort,
      limit: o.limit,
      offset: o.offset,
      project_id: o.projectId,
      owner_id: o.ownerId,
    })}`,
  );
  if (o.json) {
    emitJson(page);
    return 0;
  }
  if (page.sessions.length === 0) {
    process.stdout.write(`\n  ${C.dim}No sessions in this window.${C.reset}\n\n`);
    return 0;
  }
  const projW = Math.max(7, ...page.sessions.map((s) => s.project_name.length));
  process.stdout.write(
    `\n  ${C.bold}${pad('SESSION', 10)}  ${pad('PROJECT', projW)}  ${pad('REQS', 6)}  ${pad('LLM', 10)}  ${pad('COMPUTE', 10)}  TOTAL${C.reset}\n`,
  );
  for (const s of page.sessions) {
    process.stdout.write(
      `  ${pad(s.session_id.slice(0, 8), 10)}  ${pad(s.project_name, projW)}  ${pad(String(s.request_count), 6)}  ${pad(money(s.llm_cost), 10)}  ${pad(money(s.compute_cost), 10)}  ${money(s.total_cost)}\n`,
    );
  }
  process.stdout.write(`\n  ${C.dim}${page.sessions.length} of ${page.total}${C.reset}\n\n`);
  return 0;
}

async function costsSummary(
  ctx: AccountContext,
  o: { projectId?: string; sessionId?: string; from?: string; to?: string; json: boolean },
): Promise<number> {
  const summary = await ctx.client.get<CostSummaryView>(
    `/usage/cost-summary${query({
      from: o.from,
      to: o.to,
      project_id: o.projectId,
      session_id: o.sessionId,
    })}`,
  );
  if (o.json) {
    emitJson(summary);
    return 0;
  }
  const t = summary.totals;
  process.stdout.write(`\n  ${C.bold}Spend${C.reset}\n\n`);
  process.stdout.write(row('total', money(t.total_cost)));
  process.stdout.write(row('previous', money(summary.previous?.total_cost)));
  process.stdout.write(row('llm', money(t.llm_cost)));
  process.stdout.write(row('compute', money(t.compute_cost)));
  process.stdout.write(row('requests', String(t.request_count)));
  process.stdout.write(row('sessions', String(t.session_count)));
  process.stdout.write(row('projects', String(t.project_count)));
  if (summary.models?.length) {
    process.stdout.write(`\n  ${C.bold}By model${C.reset}\n`);
    for (const m of summary.models) {
      process.stdout.write(`  ${pad(`${m.provider}/${m.model}`, 40)}  ${money(m.cost)}\n`);
    }
  }
  process.stdout.write('\n');
  return 0;
}
