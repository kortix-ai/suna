import { writeFile } from 'node:fs/promises';
import { fetchCostExportCsv } from '@kortix/sdk';

import { withKortixScope } from '../api/sdk.ts';
import {
  emitJson,
  resolveAccountContext,
  surfaceApiError,
  takeFlagBool,
  takeFlagValue,
  type AccountContext,
} from '../command-helpers.ts';
import { C, help, pad, status } from '../style.ts';

// Account billing — the READ-ONLY CLI mirror of /accounts/<id>?tab=billing.
//
// Plan, credit ledger and spend only: every plan/credit CHANGE stays in the
// dashboard, so this command never POSTs. Every route below
// `/billing/account-state` 404s with `billing_disabled` on a self-hosted box
// that never enabled Stripe. Reads are scoped by the client's `?account_id=`.

const HELP = help`Usage: kortix billing <subcommand> [options]

Read the active account's plan, credits and spend. Read-only: plan changes,
top-ups and payment methods are dashboard flows.

Subcommands:
  status                            Plan, credits, seats, subscription. --json.
  transactions                      Credit ledger, newest first. --json.
    --limit <n>                     Page size. Default: 50.
    --offset <n>                    Page offset. Default: 0.
    --type <a,b>                    Filter by transaction type.
    --summary                       Credits in/out instead of rows.
    --breakdown                     Balance split (expiring/non-expiring/daily).
    --usage                         Credit usage summary.
    --days <n>                      Window for --summary / --usage. Default: 30.
  costs                             Spend over a window. --json.
    --by project|session            Roll up by project or by session.
                                    Omit for account totals + model breakdown.
    --project <id>                  Scope to one project.
    --session <id>                  Scope the totals to one session.
    --owner <id>                    Filter sessions by owner (--by session).
    --since <iso> --until <iso>     Half-open [from, to) UTC. Default: 30 days.
    --sort <k>                      total_desc (default), total_asc, recent,
                                    name_asc (--by project only).
    --limit <n> --offset <n>        Paging for --by project|session.
    --csv <file>                    Write the rows as CSV. Needs --by.

Global options:
  --account <id>     Operate on this account (default: active account).
  --host <name>      Operate against a non-default Kortix host.
  --json             Machine-readable output.
  -h, --help         Show this help.

Examples:
  kortix billing status
  kortix billing transactions --summary --days 7
  kortix billing costs --by project --since 2026-08-01T00:00:00Z
  kortix billing costs --by session --csv sessions.csv
`;

const COST_SORTS = ['total_desc', 'total_asc', 'recent', 'name_asc'] as const;

interface Flags {
  account?: string;
  host?: string;
  by?: string;
  project?: string;
  session?: string;
  owner?: string;
  since?: string;
  until?: string;
  sort?: string;
  csv?: string;
  limit?: string;
  offset?: string;
  type?: string;
  days?: string;
  json: boolean;
  summary: boolean;
  breakdown: boolean;
  usage: boolean;
}

function fail(message: string): number {
  process.stderr.write(`${status.err(message)}\n`);
  return 2;
}

function money(value: unknown): string {
  const n = Number(value);
  return Number.isFinite(n) ? `$${n.toFixed(2)}` : '—';
}

function integer(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${label} must be a non-negative integer`);
  return n;
}

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const rendered = search.toString();
  return rendered ? `?${rendered}` : '';
}

export async function runBilling(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    process.stdout.write(HELP);
    return argv.length === 0 ? 2 : 0;
  }
  const sub = argv[0];
  const rest = argv.slice(1);
  let f: Flags;
  try {
    f = {
      account: takeFlagValue(rest, ['--account']),
      host: takeFlagValue(rest, ['--host']),
      by: takeFlagValue(rest, ['--by']),
      project: takeFlagValue(rest, ['--project']),
      session: takeFlagValue(rest, ['--session']),
      owner: takeFlagValue(rest, ['--owner']),
      since: takeFlagValue(rest, ['--since', '--from']),
      until: takeFlagValue(rest, ['--until', '--to']),
      sort: takeFlagValue(rest, ['--sort']),
      csv: takeFlagValue(rest, ['--csv']),
      limit: takeFlagValue(rest, ['--limit']),
      offset: takeFlagValue(rest, ['--offset']),
      type: takeFlagValue(rest, ['--type', '--type-filter']),
      days: takeFlagValue(rest, ['--days']),
      json: takeFlagBool(rest, ['--json']),
      summary: takeFlagBool(rest, ['--summary']),
      breakdown: takeFlagBool(rest, ['--breakdown']),
      usage: takeFlagBool(rest, ['--usage']),
    };
  } catch (err) {
    return fail((err as Error).message);
  }

  const ctx = resolveAccountContext({ accountArg: f.account, hostArg: f.host });
  if (!ctx) return 1;

  try {
    switch (sub) {
      case 'status':
        return await statusCommand(ctx, f);
      case 'transactions':
      case 'tx':
        return await transactionsCommand(ctx, f);
      case 'costs':
      case 'cost':
        return await costsCommand(ctx, f);
      default:
        return fail(`unknown billing subcommand "${sub}"`);
    }
  } catch (err) {
    return surfaceApiError(err);
  }
}

// ── Reads ───────────────────────────────────────────────────────────────────

interface AccountStateView {
  credits?: { total?: number; daily?: number; monthly?: number; extra?: number; can_run?: boolean };
  billing_state?: string;
  plan?: { label?: string; sublabel?: string | null; key?: string; family?: string };
  subscription?: {
    tier_key?: string;
    tier_display_name?: string;
    status?: string;
    billing_period?: string | null;
    cancel_at_period_end?: boolean;
    current_period_end?: number | null;
    has_scheduled_change?: boolean;
  };
  tier?: { name?: string; display_name?: string };
  seats?: { count?: number; price_per_seat_usd?: number };
  member_count?: number;
  billing_model?: string;
  can_manage_billing?: boolean;
  auto_topup?: { enabled?: boolean; threshold?: number; amount?: number };
  usage_this_period?: { compute_usd?: number; llm_usd?: number; total_usd?: number } | null;
}

function row(label: string, value: string): string {
  return `  ${C.dim}${pad(label, 16)}${C.reset}${value}\n`;
}

async function statusCommand(ctx: AccountContext, f: Flags): Promise<number> {
  const state = await ctx.client.get<AccountStateView>('/billing/account-state');
  if (f.json) {
    emitJson(state);
    return 0;
  }
  const plan = state.plan?.label ?? state.tier?.display_name ?? state.subscription?.tier_key ?? '—';
  const sub = state.subscription ?? {};
  process.stdout.write(`\n  ${C.bold}Billing — ${ctx.accountId}${C.reset}\n\n`);
  process.stdout.write(
    row('plan', `${plan}${state.plan?.sublabel ? ` ${C.dim}${state.plan.sublabel}${C.reset}` : ''}`),
  );
  process.stdout.write(row('state', state.billing_state ?? sub.status ?? '—'));
  process.stdout.write(row('credits', money(state.credits?.total)));
  if (state.credits?.can_run === false) {
    process.stdout.write(row('', `${C.yellow}blocked — out of credits${C.reset}`));
  }
  if (state.billing_model) process.stdout.write(row('model', state.billing_model));
  if (state.seats?.count !== undefined) {
    process.stdout.write(
      row('seats', `${state.seats.count} × ${money(state.seats.price_per_seat_usd)}/mo`),
    );
  }
  if (state.member_count !== undefined) process.stdout.write(row('members', String(state.member_count)));
  if (sub.billing_period) process.stdout.write(row('period', sub.billing_period));
  if (sub.current_period_end) {
    process.stdout.write(row('renews', new Date(sub.current_period_end * 1000).toISOString()));
  }
  if (sub.cancel_at_period_end) process.stdout.write(row('cancels', 'at period end'));
  if (sub.has_scheduled_change) process.stdout.write(row('scheduled', 'plan change pending'));
  if (state.auto_topup) {
    process.stdout.write(
      row(
        'auto-topup',
        state.auto_topup.enabled
          ? `on — buy ${money(state.auto_topup.amount)} under ${money(state.auto_topup.threshold)}`
          : 'off',
      ),
    );
  }
  if (state.usage_this_period) {
    process.stdout.write(row('this period', money(state.usage_this_period.total_usd)));
  }
  if (state.can_manage_billing === false) {
    process.stdout.write(row('you', `${C.yellow}read-only — billing.write required${C.reset}`));
  }
  process.stdout.write('\n');
  return 0;
}

interface TransactionRow {
  id: string;
  created_at: string;
  amount: number;
  balance_after: number;
  type: string;
  description: string | null;
}

async function transactionsCommand(ctx: AccountContext, f: Flags): Promise<number> {
  const days = integer(f.days, '--days');
  if (f.summary || f.usage) {
    const path = f.summary ? '/billing/transactions/summary' : '/billing/usage-history';
    const data = await ctx.client.get<Record<string, unknown>>(`${path}${query({ days })}`);
    if (f.json) {
      emitJson(data);
      return 0;
    }
    process.stdout.write(`\n  ${C.bold}${f.summary ? 'Transaction summary' : 'Usage history'}${C.reset}\n\n`);
    for (const [key, value] of Object.entries(data)) {
      process.stdout.write(row(key, String(value)));
    }
    process.stdout.write('\n');
    return 0;
  }
  if (f.breakdown) {
    const data = await ctx.client.get<Record<string, number>>('/billing/credit-breakdown');
    if (f.json) {
      emitJson(data);
      return 0;
    }
    process.stdout.write(`\n  ${C.bold}Credit breakdown${C.reset}\n\n`);
    for (const [key, value] of Object.entries(data)) process.stdout.write(row(key, money(value)));
    process.stdout.write('\n');
    return 0;
  }

  const page = await ctx.client.get<{
    transactions: TransactionRow[];
    pagination: { total: number; limit: number; offset: number; has_more: boolean };
  }>(
    `/billing/transactions${query({
      limit: integer(f.limit, '--limit'),
      offset: integer(f.offset, '--offset'),
      type_filter: f.type,
    })}`,
  );
  if (f.json) {
    emitJson(page);
    return 0;
  }
  if (page.transactions.length === 0) {
    process.stdout.write(`\n  ${C.dim}No transactions.${C.reset}\n\n`);
    return 0;
  }
  const typeW = Math.max(4, ...page.transactions.map((t) => t.type.length));
  process.stdout.write(`\n  ${C.bold}${pad('WHEN', 20)}  ${pad('TYPE', typeW)}  ${pad('AMOUNT', 10)}  BALANCE${C.reset}\n`);
  for (const t of page.transactions) {
    const when = String(t.created_at).slice(0, 19).replace('T', ' ');
    const amount = `${t.amount >= 0 ? '+' : '-'}${money(Math.abs(t.amount))}`;
    process.stdout.write(
      `  ${pad(when, 20)}  ${pad(t.type, typeW)}  ${pad(amount, 10)}  ${money(t.balance_after)}\n`,
    );
    if (t.description) process.stdout.write(`  ${C.dim}${t.description}${C.reset}\n`);
  }
  const { total, offset, limit, has_more } = page.pagination;
  process.stdout.write(
    `\n  ${C.dim}${offset + page.transactions.length} of ${total}${has_more ? ` — next: --offset ${offset + limit}` : ''}${C.reset}\n\n`,
  );
  return 0;
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

async function costsCommand(ctx: AccountContext, f: Flags): Promise<number> {
  const by = f.by;
  if (by !== undefined && by !== 'project' && by !== 'session') {
    return fail('--by must be project or session');
  }
  if (f.sort && !COST_SORTS.includes(f.sort as (typeof COST_SORTS)[number])) {
    return fail(`--sort must be one of ${COST_SORTS.join(', ')}`);
  }
  if (f.sort === 'name_asc' && by !== 'project') {
    return fail('--sort name_asc is only valid with --by project');
  }
  if (f.csv && !by) {
    return fail('--csv needs --by project or --by session; the account summary has no CSV export');
  }

  if (f.csv) {
    // Both CSV routes require a Bearer token, so `fetchCostExportCsv` in the
    // SDK owns the authenticated transport. `x-kortix-row-cap` is the server's
    // row cap — surface it so a truncated finance export is never silent.
    const kind = by === 'project' ? 'projects' : 'sessions';
    const options =
      kind === 'projects'
        ? { accountId: ctx.accountId, from: f.since, to: f.until, sort: f.sort as never }
        : {
            accountId: ctx.accountId,
            projectId: f.project,
            ownerId: f.owner,
            from: f.since,
            to: f.until,
            sort: f.sort as never,
          };
    const result = await withKortixScope(ctx.auth, () =>
      kind === 'projects'
        ? fetchCostExportCsv('projects', options)
        : fetchCostExportCsv('sessions', options),
    );
    const bytes = new Uint8Array(await result.blob.arrayBuffer());
    await writeFile(f.csv, bytes);
    if (f.json) {
      emitJson({ file: f.csv, bytes: bytes.byteLength, row_cap: result.rowCap });
      return 0;
    }
    process.stdout.write(`\n  ${status.ok(`wrote ${bytes.byteLength} bytes to ${f.csv}`)}\n`);
    if (result.rowCap !== null) {
      process.stdout.write(`  ${C.dim}capped at ${result.rowCap} rows${C.reset}\n`);
    }
    process.stdout.write('\n');
    return 0;
  }

  const window = { from: f.since, to: f.until, sort: f.sort };
  const paging = { limit: integer(f.limit, '--limit'), offset: integer(f.offset, '--offset') };

  if (by === 'project') {
    const page = await ctx.client.get<ProjectCostView>(
      `/usage/cost-by-project${query({ ...window, ...paging })}`,
    );
    if (f.json) {
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

  if (by === 'session') {
    const page = await ctx.client.get<SessionCostView>(
      `/usage/session-costs${query({ ...window, ...paging, project_id: f.project, owner_id: f.owner })}`,
    );
    if (f.json) {
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

  const summary = await ctx.client.get<CostSummaryView>(
    `/usage/cost-summary${query({
      from: f.since,
      to: f.until,
      project_id: f.project,
      session_id: f.session,
    })}`,
  );
  if (f.json) {
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
