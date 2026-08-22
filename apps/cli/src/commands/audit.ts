import { writeFileSync } from 'node:fs';
import { downloadAccountAudit, type AuditEvent, type AuditEventList } from '@kortix/sdk';
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
//     semantic session/connectors/approval events. Enterprise-gated.
//   - `session` reads ONE session's agent-action log, which is a different
//     route with a different gate — a non-Enterprise account still sees its
//     pending approvals there, never a 402.

type AuditPage = AuditEventList;

const HELP = help`Usage: kortix audit <subcommand> [options]

Read the account audit trail — who did what, when, and whether it was allowed.
Every authenticated API request is recorded, plus semantic session, connector,
and approval events. The account trail requires the Enterprise plan.

Subcommands:
  ls [filters] [--json]           List audit events, newest first.
  export [filters] [--out <f>]    Export matching events as CSV or JSONL.
  project <project-id> [--json]   One project's canonical audit log.
  session <session-id> --project <project-id> [--json]
                                   One session's canonical ordered timeline.

Stream the trail to a SIEM (needs account.write; create/enable also needs the
Enterprise entitlement — disable and delete never do):
  webhooks ls [--json]            List audit webhooks.
  webhooks add --name <n> --url <u> [--action-prefix <p>]
                                  Create one. The signing secret prints ONCE,
                                  and a test delivery fires immediately.
  webhooks enable <webhook-id>    Resume delivery.
  webhooks disable <webhook-id>   Pause delivery, keeping the endpoint.
  webhooks rm <webhook-id>        Delete permanently.

Filters (ls, export, project):
  --since <when>       Only events at or after this point. ISO-8601, or a
                       relative span like 30m, 24h, 7d, 2w.
  --until <when>       Only events at or before this point.
  --action <prefix>    Action prefix, e.g. "iam.policy." or "session.".
  --actor <user-id>    Only this actor.
  --actor-type <t>     human | agent | service_account | system
  --outcome <o>        success | failure | denied | pending
  --project <id>       Only this project.
  --session <id>       Only this session.
  --source <s>         Trusted execution source or reported client surface,
                       e.g. "agent", "opencode", "cli", "web".
  --phase <p>          Lifecycle phase, e.g. pending, completed, failed.
  --resource-type <t>  Only this resource type.
  --request-id <id>    One request.
  --correlation-id <id>  One correlated chain of events.
  -q, --query <text>   Free-text match on action, resource, project, session.

Options:
  --limit <n>          Events per page (default 50, server max 200).
  --cursor <c>         Resume from a previous page's next_cursor.
  --all                Follow cursors until every matching event is returned.
  --format <f>         export: csv (default) | jsonl.
  --out <file>         export: write to a file instead of stdout.
  --name <n>           webhooks add: a label for this endpoint.
  --url <u>            webhooks add: the http(s) endpoint to POST events to.
  --action-prefix <p>  webhooks add: only deliver actions with this prefix.
  --account <id>       Operate on this account (default: active account).
  --json               Machine-readable output.
  -h, --help           Show this help.

Examples:
  kortix audit ls --since 24h
  kortix audit ls --outcome denied --since 7d
  kortix audit ls --action iam. --json
  kortix audit ls --project <project-id> --all
  kortix audit session <session-id> --project <project-id>
  kortix audit export --since 30d --format jsonl --out audit.jsonl
  kortix audit webhooks add --name splunk --url https://siem.corp.com/kortix
`;

interface AuditWebhook {
  webhook_id: string;
  name: string;
  url: string;
  enabled: boolean;
  action_prefix: string | null;
  last_delivered_at: string | null;
  last_error_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  secret?: string;
  test?: { ok: boolean; status?: number; error?: string };
}

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
    ['phase', flags.phase],
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
    if (!iso)
      return { error: `--${key} "${raw}" is not an ISO-8601 instant or a span like 24h/7d.` };
    search.set(key, iso);
  }
  return { search };
}

interface AuditContext {
  client: ApiClient;
  accountId: string;
  auth: NonNullable<ReturnType<typeof loadAuth>>;
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
  return { client: clientFromAuth(auth, { accountId }), accountId, auth };
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

async function collectAuditPages(
  fetchPage: (cursor: string | null) => Promise<AuditPage>,
  initialCursor: string | null,
  followAll: boolean,
): Promise<{ events: AuditEvent[]; nextCursor: string | null }> {
  const events: AuditEvent[] = [];
  let cursor = initialCursor;
  const seen = new Set<string>();
  if (cursor) seen.add(cursor);
  for (;;) {
    const page = await fetchPage(cursor);
    events.push(...page.events);
    const nextCursor = page.next_cursor;
    if (!followAll || !nextCursor) return { events, nextCursor };
    if (seen.has(nextCursor)) {
      throw new Error('audit pagination returned a repeated continuation cursor');
    }
    seen.add(nextCursor);
    cursor = nextCursor;
  }
}

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
    f.phase = takeFlagValue(rest, ['--phase']);
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
    f.name = takeFlagValue(rest, ['--name']);
    f.url = takeFlagValue(rest, ['--url']);
    f.actionPrefix = takeFlagValue(rest, ['--action-prefix']);
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

        const collected = await collectAuditPages(
          async (cursor) => {
            if (cursor) search.set('cursor', cursor);
            else search.delete('cursor');
            return ctx.client.get<AuditPage>(`${base}?${search.toString()}`);
          },
          f.cursor ?? null,
          all,
        );

        if (json) {
          emitJson({
            events: collected.events,
            next_cursor: all ? null : collected.nextCursor,
          });
          return 0;
        }
        printEvents(collected.events);
        const count = `${collected.events.length} event${collected.events.length === 1 ? '' : 's'}`;
        process.stdout.write(`\n  ${C.dim}${count}${C.reset}`);
        if (collected.nextCursor && !all) {
          process.stdout.write(
            `  ${C.dim}more available — use --all, or --cursor ${collected.nextCursor}${C.reset}`,
          );
        }
        process.stdout.write('\n\n');
        return 0;
      }

      case 'project': {
        const projectId = positional[0] ?? f.project;
        if (!projectId) {
          process.stderr.write(`${status.err('Missing a project id.')}` + '\n');
          return 2;
        }
        const built = buildAuditQuery({ ...f, project: undefined });
        if ('error' in built) {
          process.stderr.write(`${status.err(built.error)}\n`);
          return 2;
        }
        const { search } = built;
        if (f.limit) search.set('limit', f.limit);
        if (f.cursor) search.set('cursor', f.cursor);
        const collected = await collectAuditPages(
          async (cursor) => {
            if (cursor) search.set('cursor', cursor);
            else search.delete('cursor');
            return ctx.client.get<AuditPage>(
              `/projects/${encodeURIComponent(projectId)}/audit?${search.toString()}`,
            );
          },
          f.cursor ?? null,
          all,
        );
        if (json) {
          emitJson({
            events: collected.events,
            next_cursor: all ? null : collected.nextCursor,
          });
          return 0;
        }
        printEvents(collected.events);
        process.stdout.write(
          `\n  ${C.dim}${collected.events.length} event${collected.events.length === 1 ? '' : 's'}${C.reset}`,
        );
        if (collected.nextCursor && !all)
          process.stdout.write(`  ${C.dim}more available — use --all${C.reset}`);
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
        let cursor = f.cursor ?? undefined;
        const chunks: string[] = [];
        let firstPage = true;
        for (;;) {
          const page = await downloadAccountAudit(
            ctx.accountId,
            {
              format,
              action: search.get('action') ?? undefined,
              actor: search.get('actor') ?? undefined,
              project_id: search.get('project_id') ?? undefined,
              session_id: search.get('session_id') ?? undefined,
              actor_type: search.get('actor_type') as
                | 'human'
                | 'agent'
                | 'service_account'
                | 'system'
                | undefined,
              source: search.get('source') ?? undefined,
              phase: search.get('phase') ?? undefined,
              outcome: search.get('outcome') as
                | 'success'
                | 'failure'
                | 'denied'
                | 'pending'
                | undefined,
              request_id: search.get('request_id') ?? undefined,
              correlation_id: search.get('correlation_id') ?? undefined,
              resource_type: search.get('resource_type') ?? undefined,
              since: search.get('since') ?? undefined,
              until: search.get('until') ?? undefined,
              q: search.get('q') ?? undefined,
              cursor,
              limit: f.limit ? Number(f.limit) : undefined,
            },
            { backendUrl: ctx.auth.api_base, accessToken: ctx.auth.token },
          );
          let chunk = await page.blob.text();
          if (format === 'csv' && !firstPage) chunk = chunk.replace(/^[^\r\n]*(?:\r?\n|$)/, '');
          if (chunk) chunks.push(chunk.replace(/\s+$/, ''));
          firstPage = false;
          if (page.complete) break;
          if (!page.nextCursor || page.nextCursor === cursor) {
            throw new Error('audit export returned an invalid continuation cursor');
          }
          cursor = page.nextCursor;
        }
        const text = chunks.filter(Boolean).join('\n');
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
        const sessionSearch = new URLSearchParams();
        if (f.limit) sessionSearch.set('limit', f.limit);
        if (f.cursor) sessionSearch.set('cursor', f.cursor);
        const collected = await collectAuditPages(
          async (cursor) => {
            if (cursor) sessionSearch.set('cursor', cursor);
            else sessionSearch.delete('cursor');
            const query = sessionSearch.size ? `?${sessionSearch.toString()}` : '';
            return ctx.client.get<AuditPage>(
              `/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/audit${query}`,
            );
          },
          f.cursor ?? null,
          all,
        );
        if (json) {
          emitJson({
            events: collected.events,
            next_cursor: all ? null : collected.nextCursor,
          });
          return 0;
        }
        const events = collected.events;
        if (events.length === 0) {
          printEvents(events);
          return 0;
        }
        printEvents(events);
        if (collected.nextCursor && !all) {
          process.stdout.write(
            `\n  ${C.dim}more available — use --all, or --cursor ${collected.nextCursor}${C.reset}`,
          );
        }
        process.stdout.write('\n');
        return 0;
      }

      case 'webhooks': {
        const verb = positional[0];
        const webhookId = positional[1];
        switch (verb) {
          case undefined:
          case 'ls':
          case 'list': {
            const { webhooks } = await ctx.client.get<{ webhooks: AuditWebhook[] }>(
              `${base}/webhooks`,
            );
            if (json) {
              emitJson(webhooks);
              return 0;
            }
            if (webhooks.length === 0) {
              process.stdout.write(
                `\n  ${C.dim}No audit webhooks. Add one with ` +
                  `${C.reset}${C.cyan}kortix audit webhooks add --name <n> --url <u>${C.reset}\n\n`,
              );
              return 0;
            }
            const nameW = Math.max(...webhooks.map((w) => w.name.length), 4);
            const urlW = Math.min(Math.max(...webhooks.map((w) => w.url.length), 3), 48);
            process.stdout.write('\n');
            process.stdout.write(
              `  ${C.dim}${pad('NAME', nameW)}   ${pad('URL', urlW)}   ${pad('STATE', 8)}   ${pad('PREFIX', 12)}   WEBHOOK ID${C.reset}\n`,
            );
            for (const w of webhooks) {
              const state = w.enabled ? 'enabled' : `${C.yellow}disabled${C.reset}`;
              process.stdout.write(
                `  ${pad(w.name, nameW)}   ${pad(truncate(w.url, urlW), urlW)}   ${pad(state, 8)}   ` +
                  `${pad(w.action_prefix ?? 'all', 12)}   ${C.faded}${w.webhook_id}${C.reset}\n`,
              );
              if (w.last_error) {
                process.stdout.write(
                  `  ${C.red}└ last error${C.reset} ${C.dim}${w.last_error_at?.slice(0, 19).replace('T', ' ') ?? ''}${C.reset} ${truncate(w.last_error, 80)}\n`,
                );
              }
            }
            process.stdout.write(
              `\n  ${C.dim}${webhooks.length} webhook${webhooks.length === 1 ? '' : 's'}${C.reset}\n\n`,
            );
            return 0;
          }

          case 'add':
          case 'create': {
            if (!f.name) {
              process.stderr.write(`${status.err('Pass --name <label>.')}\n`);
              return 2;
            }
            if (!f.url) {
              process.stderr.write(`${status.err('Pass --url <https endpoint>.')}\n`);
              return 2;
            }
            const created = await ctx.client.post<AuditWebhook>(`${base}/webhooks`, {
              name: f.name,
              url: f.url,
              ...(f.actionPrefix ? { action_prefix: f.actionPrefix } : {}),
            });
            if (json) {
              emitJson(created);
              return 0;
            }
            process.stdout.write(
              `${status.ok(`Created webhook ${C.bold}${created.name}${C.reset} → ${created.url}`)}\n\n`,
            );
            process.stdout.write(`  ${created.secret ?? '(no secret returned)'}\n\n`);
            process.stdout.write(
              `${status.warn('This is the only time the signing secret is shown. Store it now.')}\n`,
            );
            process.stdout.write(`  ${C.dim}webhook_id ${C.reset}${created.webhook_id}\n`);
            // The server fires one test delivery on create so a mistyped URL
            // surfaces now, not at the first real event.
            if (created.test) {
              process.stdout.write(
                created.test.ok
                  ? `  ${C.dim}test       ${C.reset}${C.green}delivered${C.reset}${created.test.status ? ` ${C.faded}(HTTP ${created.test.status})${C.reset}` : ''}\n`
                  : `  ${C.dim}test       ${C.reset}${C.red}failed${C.reset} ${created.test.error ?? `HTTP ${created.test.status}`}\n`,
              );
            }
            return 0;
          }

          case 'enable':
          case 'disable': {
            if (!webhookId) {
              process.stderr.write(
                `${status.err('Pass a webhook id (see `kortix audit webhooks ls`).')}\n`,
              );
              return 2;
            }
            const updated = await ctx.client.patch<AuditWebhook>(
              `${base}/webhooks/${encodeURIComponent(webhookId)}`,
              { enabled: verb === 'enable' },
            );
            if (json) {
              emitJson(updated);
              return 0;
            }
            process.stdout.write(
              `${status.ok(`${C.bold}${updated.name}${C.reset} ${updated.enabled ? 'enabled' : 'disabled'}`)}\n`,
            );
            return 0;
          }

          case 'rm':
          case 'delete': {
            if (!webhookId) {
              process.stderr.write(
                `${status.err('Pass a webhook id (see `kortix audit webhooks ls`).')}\n`,
              );
              return 2;
            }
            await ctx.client.delete(`${base}/webhooks/${encodeURIComponent(webhookId)}`);
            process.stdout.write(
              `${status.ok(`Deleted webhook ${C.bold}${webhookId}${C.reset}`)}\n`,
            );
            return 0;
          }

          default:
            process.stderr.write(
              `${status.err(`unknown webhooks verb "${verb}" — use ls|add|enable|disable|rm`)}\n`,
            );
            return 2;
        }
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
