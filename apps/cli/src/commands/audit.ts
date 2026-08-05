import { writeFileSync } from 'node:fs';
import { loadAuth } from '../api/auth.ts';
import { activeAccount } from '../api/config.ts';
import { clientFromAuth, type ApiClient } from '../api/client.ts';
import { emitJson, surfaceApiError, takeFlagValue, takeFlagBool } from '../command-helpers.ts';
import { C, help, pad, status } from '../style.ts';

// The account audit trail — the CLI face of `kortix.audit_events`, which the
// dashboard already reads. Reads are gated server-side on `audit.read` plus the
// account's `auditAccess` entitlement, so a non-Enterprise account gets a 402
// that this command translates instead of printing raw.
//
// Two different logs live behind one noun, and conflating them would be the
// obvious mistake:
//   - `ls`/`export` read the ACCOUNT trail: every authenticated request, plus
//     semantic session/executor/approval events. Enterprise-gated.
//   - `session` reads ONE session's agent-action log, which is a different
//     route with a different gate — a non-Enterprise account still sees its
//     pending approvals there, never a 402.

interface AuditEvent {
  event_id: string;
  occurred_at: string;
  project_id: string | null;
  session_id: string | null;
  actor_user_id: string | null;
  actor_type: 'human' | 'agent' | 'service_account' | 'system' | null;
  source: string | null;
  outcome: 'success' | 'failure' | 'denied' | 'pending' | null;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  http_status: number | null;
  duration_ms: number | null;
  request_id: string | null;
  trace_id: string | null;
  correlation_id: string | null;
  before: unknown;
  after: unknown;
  ip: string | null;
  user_agent: string | null;
  metadata: unknown;
}

interface AuditPage {
  events: AuditEvent[];
  next_cursor: string | null;
}

const HELP = help`Usage: kortix audit <subcommand> [options]

Read the account audit trail — who did what, when, and whether it was allowed.
Every authenticated API request is recorded, plus semantic session, executor,
and approval events. The account trail requires the Enterprise plan.

Subcommands:
  ls [filters] [--json]           List audit events, newest first.
  export [filters] [--out <f>]    Export matching events as CSV or JSONL.
  session <session-id> [--json]   One session's agent-action log.

Filters (ls, export):
  --since <when>       Only events at or after this point. ISO-8601, or a
                       relative span like 30m, 24h, 7d, 2w.
  --until <when>       Only events at or before this point.
  --action <prefix>    Action prefix, e.g. "iam.policy." or "session.".
  --actor <user-id>    Only this actor.
  --actor-type <t>     human | agent | service_account | system
  --outcome <o>        success | failure | denied | pending
  --project <id>       Only this project.
  --session <id>       Only this session.
  --source <s>         Originating surface, e.g. "api", "cli".
  --resource-type <t>  Only this resource type.
  --request-id <id>    One request.
  --correlation-id <id>  One correlated chain of events.
  -q, --query <text>   Free-text match on action, resource, project, session.

Options:
  --limit <n>          Events per page (default 50, server max 200).
  --cursor <c>         Resume from a previous page's next_cursor.
  --all                Follow cursors and print every match (max 10000).
  --format <f>         export: csv (default) | jsonl.
  --out <file>         export: write to a file instead of stdout.
  --account <id>       Operate on this account (default: active account).
  --json               Machine-readable output.
  -h, --help           Show this help.

Examples:
  kortix audit ls --since 24h
  kortix audit ls --outcome denied --since 7d
  kortix audit ls --action iam. --json
  kortix audit ls --project <project-id> --all
  kortix audit session <session-id>
  kortix audit export --since 30d --format jsonl --out audit.jsonl
`;

const RELATIVE_SPAN = /^(\d+)\s*(m|h|d|w)$/i;
const SPAN_MS: Record<string, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/**
 * Accept `24h` / `7d` as well as ISO-8601.
 *
 * Relative spans are what people actually type when reading a log, and the API
 * only speaks ISO. Resolved here, against the caller's clock, so what gets sent
 * is unambiguous and shows up in `--json` output as the instant it really used.
 */
export function resolveInstant(input: string, now: Date = new Date()): string | null {
  const value = input.trim();
  if (!value) return null;
  const relative = RELATIVE_SPAN.exec(value);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2]!.toLowerCase();
    if (!Number.isFinite(amount) || amount <= 0) return null;
    return new Date(now.getTime() - amount * SPAN_MS[unit]!).toISOString();
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** Query string shared by `ls` and `export`, so the two can never drift. */
export function buildAuditQuery(
  flags: Record<string, string | undefined>,
  now: Date = new Date(),
): { search: URLSearchParams } | { error: string } {
  const search = new URLSearchParams();
  const direct: Array<[string, string | undefined]> = [
    ['action', flags.action],
    ['actor', flags.actor],
    ['actor_type', flags.actorType],
    ['project_id', flags.project],
    ['session_id', flags.session],
    ['source', flags.source],
    ['outcome', flags.outcome],
    ['resource_type', flags.resourceType],
    ['request_id', flags.requestId],
    ['correlation_id', flags.correlationId],
    ['q', flags.query],
  ];
  for (const [key, value] of direct) if (value) search.set(key, value);

  for (const key of ['since', 'until'] as const) {
    const raw = flags[key];
    if (!raw) continue;
    const iso = resolveInstant(raw, now);
    // Refuse rather than silently dropping the bound: a filter that quietly
    // does not apply makes an audit read look complete when it is not.
    if (!iso) return { error: `--${key} "${raw}" is not an ISO-8601 instant or a span like 24h/7d.` };
    search.set(key, iso);
  }
  return { search };
}

interface AuditContext {
  client: ApiClient;
  accountId: string;
}

function resolveAccountContext(accountArg?: string): AuditContext | null {
  const auth = loadAuth();
  if (!auth?.token) {
    process.stderr.write(`${status.err('Not logged in. Run `kortix login`.')}\n`);
    return null;
  }
  const accountId = accountArg || activeAccount()?.id || auth.account_id || '';
  if (!accountId) {
    process.stderr.write(
      `${status.err('No active account. Run `kortix accounts use` or pass --account <id>.')}\n`,
    );
    return null;
  }
  return { client: clientFromAuth(auth, { accountId }), accountId };
}

/**
 * Translate the entitlement 402 before it reaches the generic handler.
 *
 * `surfaceApiError` would print "HTTP 402: …", which reads like a billing
 * failure on a request you already made. This is a plan boundary, so it gets a
 * plain sentence and a distinct exit code from a real error.
 */
function surfaceAuditError(err: unknown): number {
  // Read `.status` structurally rather than via `instanceof`: the SDK
  // reclassifies a 402 into a sibling error type (BillingError) that extends
  // Error directly, and an instanceof check would collapse it into the generic
  // handler — printing a billing failure where a plan boundary belongs. Same
  // reasoning as `unwrap` in api/client.ts.
  const httpStatus = (err as { status?: unknown } | null)?.status;
  if (httpStatus === 402) {
    process.stderr.write(
      `${status.err('The account audit log is an Enterprise feature and is not enabled for this account.')}\n`,
    );
    process.stderr.write(
      `  ${C.dim}Per-session agent actions are still available: ${C.reset}kortix audit session <session-id>\n`,
    );
    return 1;
  }
  return surfaceApiError(err);
}

function shortTime(iso: string): string {
  // `2026-08-05T11:14:20.123Z` → `08-05 11:14:20`. The year is noise in a log
  // you are scanning; the seconds are not.
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 19).replace('T', ' ');
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

/** Longest ACTION cell before the table starts pushing RESOURCE off-screen.
 *  Audit actions are raw HTTP lines carrying UUIDs, so most rows would otherwise
 *  be ~70 chars of mostly-identical path. Full values are always in `--json`. */
const ACTION_MAX = 52;

export function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function outcomeCell(outcome: AuditEvent['outcome']): string {
  const label = outcome ?? '—';
  if (outcome === 'failure' || outcome === 'denied') return `${C.red}${pad(label, 8)}${C.reset}`;
  if (outcome === 'pending') return `${C.yellow}${pad(label, 8)}${C.reset}`;
  return `${C.faded}${pad(label, 8)}${C.reset}`;
}

function actorCell(event: AuditEvent): string {
  if (event.actor_type && event.actor_type !== 'human') return event.actor_type;
  return event.actor_user_id ? event.actor_user_id.slice(0, 8) : '—';
}

function printEvents(events: AuditEvent[]): void {
  if (events.length === 0) {
    process.stdout.write(`\n  ${C.dim}No audit events match.${C.reset}\n\n`);
    return;
  }
  const actionW = Math.min(Math.max(...events.map((e) => e.action.length), 6), ACTION_MAX);
  const actorW = Math.max(...events.map((e) => actorCell(e).length), 5);
  process.stdout.write('\n');
  process.stdout.write(
    `  ${C.dim}${pad('WHEN (UTC)', 15)}   ${pad('ACTOR', actorW)}   ${pad('ACTION', actionW)}   ${pad('OUTCOME', 8)}   RESOURCE${C.reset}\n`,
  );
  for (const e of events) {
    const resource = e.resource_type
      ? `${e.resource_type}${e.resource_id ? ` ${C.faded}${e.resource_id.slice(0, 8)}${C.reset}` : ''}`
      : `${C.faded}—${C.reset}`;
    process.stdout.write(
      `  ${pad(shortTime(e.occurred_at), 15)}   ${pad(actorCell(e), actorW)}   ${pad(truncate(e.action, ACTION_MAX), actionW)}   ${outcomeCell(e.outcome)}   ${resource}\n`,
    );
  }
}

/**
 * Read an export response body as text.
 *
 * The shared HTTP client parses `application/json`, passes `text/*` through,
 * and returns a **Blob** for everything else. The CSV export is `text/csv` so
 * it arrives as a string; the JSONL export is `application/x-ndjson`, which
 * matches neither branch and arrives as a Blob. `JSON.stringify` on a Blob
 * yields `"{}"` — which is exactly what `--format jsonl` printed before this:
 * an empty object where the export should be.
 *
 * Handled here rather than in the SDK because widening that content-type check
 * changes what every other caller receives. The SDK bug is real and worth
 * fixing separately.
 */
export async function exportBodyText(body: unknown): Promise<string> {
  if (typeof body === 'string') return body;
  if (body instanceof Blob) return await body.text();
  return JSON.stringify(body);
}

const MAX_FOLLOW_EVENTS = 10_000;

export async function runAudit(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    process.stdout.write(HELP);
    return argv.length === 0 ? 2 : 0;
  }
  const sub = argv[0];
  const rest = argv.slice(1);
  const f: Record<string, string | undefined> = {};
  let json = false;
  let all = false;
  try {
    f.account = takeFlagValue(rest, ['--account']);
    f.action = takeFlagValue(rest, ['--action']);
    f.actor = takeFlagValue(rest, ['--actor']);
    f.actorType = takeFlagValue(rest, ['--actor-type']);
    f.project = takeFlagValue(rest, ['--project']);
    f.session = takeFlagValue(rest, ['--session']);
    f.source = takeFlagValue(rest, ['--source']);
    f.outcome = takeFlagValue(rest, ['--outcome']);
    f.resourceType = takeFlagValue(rest, ['--resource-type']);
    f.requestId = takeFlagValue(rest, ['--request-id']);
    f.correlationId = takeFlagValue(rest, ['--correlation-id']);
    f.since = takeFlagValue(rest, ['--since']);
    f.until = takeFlagValue(rest, ['--until']);
    f.query = takeFlagValue(rest, ['-q', '--query']);
    f.limit = takeFlagValue(rest, ['--limit']);
    f.cursor = takeFlagValue(rest, ['--cursor']);
    f.format = takeFlagValue(rest, ['--format']);
    f.out = takeFlagValue(rest, ['--out']);
    json = takeFlagBool(rest, ['--json']);
    all = takeFlagBool(rest, ['--all']);
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }
  const positional = rest.filter((a) => !a.startsWith('-'));

  const ctx = resolveAccountContext(f.account);
  if (!ctx) return 1;
  const base = `/accounts/${ctx.accountId}/audit`;

  try {
    switch (sub) {
      case 'ls':
      case 'list': {
        const built = buildAuditQuery(f);
        if ('error' in built) {
          process.stderr.write(`${status.err(built.error)}\n`);
          return 2;
        }
        const { search } = built;
        if (f.limit) search.set('limit', f.limit);
        if (f.cursor) search.set('cursor', f.cursor);

        const collected: AuditEvent[] = [];
        let cursor: string | null = f.cursor ?? null;
        let truncated = false;
        for (;;) {
          if (cursor) search.set('cursor', cursor);
          const page: AuditPage = await ctx.client.get<AuditPage>(`${base}?${search.toString()}`);
          collected.push(...page.events);
          cursor = page.next_cursor;
          if (!all || !cursor) break;
          if (collected.length >= MAX_FOLLOW_EVENTS) {
            truncated = true;
            break;
          }
        }

        if (json) {
          // `next_cursor` is part of the contract even under --all, so a script
          // can tell a complete read from a capped one.
          emitJson({ events: collected, next_cursor: truncated ? cursor : all ? null : cursor });
          return 0;
        }
        printEvents(collected);
        const count = `${collected.length} event${collected.length === 1 ? '' : 's'}`;
        process.stdout.write(`\n  ${C.dim}${count}${C.reset}`);
        if (truncated) {
          process.stdout.write(
            `  ${C.yellow}capped at ${MAX_FOLLOW_EVENTS}; narrow with --since or --action${C.reset}`,
          );
        } else if (cursor && !all) {
          process.stdout.write(`  ${C.dim}more available — use --all, or --cursor ${cursor}${C.reset}`);
        }
        process.stdout.write('\n\n');
        return 0;
      }

      case 'export': {
        const built = buildAuditQuery(f);
        if ('error' in built) {
          process.stderr.write(`${status.err(built.error)}\n`);
          return 2;
        }
        const format = (f.format || 'csv').toLowerCase();
        if (format !== 'csv' && format !== 'jsonl') {
          process.stderr.write(`${status.err('--format must be csv or jsonl.')}\n`);
          return 2;
        }
        const { search } = built;
        search.set('format', format);
        const body = await ctx.client.get<unknown>(`${base}/export?${search.toString()}`);
        const text = await exportBodyText(body);
        if (f.out) {
          writeFileSync(f.out, text);
          const lines = text.split('\n').filter(Boolean).length;
          process.stdout.write(
            `${status.ok(`Wrote ${lines} line${lines === 1 ? '' : 's'} to ${f.out}`)}\n`,
          );
          return 0;
        }
        process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
        return 0;
      }

      case 'session': {
        const sessionId = positional[0];
        if (!sessionId) {
          process.stderr.write(`${status.err('Missing a session id.')}\n`);
          return 2;
        }
        const projectId = f.project;
        if (!projectId) {
          process.stderr.write(
            `${status.err('Pass --project <id> — the session audit route is project-scoped.')}\n`,
          );
          return 2;
        }
        const query = f.limit ? `?limit=${encodeURIComponent(f.limit)}` : '';
        const result = await ctx.client.get<unknown>(
          `/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/audit${query}`,
        );
        if (json) return emitJson(result), 0;
        const events = Array.isArray((result as { events?: unknown })?.events)
          ? ((result as { events: AuditEvent[] }).events ?? [])
          : [];
        if (events.length === 0) {
          // The shape here is owned by the session route, not the account one.
          // Print what came back rather than asserting a table over it.
          emitJson(result);
          return 0;
        }
        printEvents(events);
        process.stdout.write('\n');
        return 0;
      }

      default:
        process.stderr.write(`${status.err(`Unknown subcommand "${sub}".`)}\n`);
        process.stdout.write(HELP);
        return 2;
    }
  } catch (err) {
    return surfaceAuditError(err);
  }
}
