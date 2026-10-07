import { writeFileSync } from 'node:fs';
import { downloadAccountAudit, type AuditEvent, type AuditEventList } from '@kortix/sdk';
import { splitHelp } from '../command-argv.ts';
import {
  emitJson,
  fail,
  missing,
  resolveAccountContext,
  resolveSpanInstant,
  surfaceApiError,
  takeFlagBool,
  takeFlagValue,
  type AccountContext,
} from '../command-helpers.ts';
import { trim, C, help, pad, status } from '../style.ts';
import { auditLabelForAction, auditLabelForHttpAction } from '@kortix/shared/audit-labels';
import { printEvents } from './audit-render.ts';

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
  ls [filters] [--json]           List audit events of the last 90 days, newest first.
  export [filters] [--out <f>]    Export matching events as CSV or JSONL. Reaches back
                                  365 days: events older than 90 days come from the
                                  archive.
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
  --actor-type <t>     human | agent | service_account | system | anonymous
  --outcome <o>        success | failure | denied | pending
  --project <id>       Only this project.
  --session <id>       Only this session.
  --source <s>         Trusted execution source, e.g. "human", "agent",
                       "api_key", "opencode".
  --credential-kind <k>  What the API authenticated: browser_session,
                       personal_access_token, oauth_app, session_token,
                       api_key, service_account, scim_token.
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
  --host <name>        Operate against a non-default Kortix host.
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

/**
 * Accept `24h` / `7d` as well as ISO-8601.
 *
 * Relative spans are what people actually type when reading a log, and the API
 * only speaks ISO. Resolved here, against the caller's clock, so what gets sent
 * is unambiguous and shows up in `--json` output as the instant it really used.
 */
export function resolveInstant(input: string, now: Date = new Date()): string | null {
  return resolveSpanInstant(input, now, -1);
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
    ['credential_kind', flags.credentialKind],
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

/**
 * One paged audit read, shared by `ls`, `project` and `session`: the query
 * build and its refusal of an unparseable time bound, the --limit/--cursor
 * flags, the pagination loop (a repeated continuation cursor aborts), the
 * `--json` shape, and the table + footer.
 *
 * `url` turns the (cursor-mutated) query into the request URL, so each
 * subcommand owns only its route — `session` appends the query string only
 * when there is one. The footer differs per subcommand, and `session`'s route
 * takes no filters, so it also skips the shared query build: that build REFUSES
 * an unparseable --since, which the session route silently ignores.
 */
async function listAuditEvents(
  ctx: AccountContext,
  url: (search: URLSearchParams) => string,
  f: Record<string, string | undefined>,
  all: boolean,
  json: boolean,
  footer: 'ls' | 'project' | 'session',
): Promise<number> {
  let search: URLSearchParams;
  if (footer === 'session') {
    search = new URLSearchParams();
  } else {
    const built = buildAuditQuery(f);
    if ('error' in built) return fail(built.error);
    search = built.search;
  }
  if (f.limit) search.set('limit', f.limit);
  if (f.cursor) search.set('cursor', f.cursor);

  const events: AuditEvent[] = [];
  let cursor = f.cursor ?? null;
  const seen = new Set<string>();
  if (cursor) seen.add(cursor);
  let nextCursor: string | null = null;
  for (;;) {
    if (cursor) search.set('cursor', cursor);
    else search.delete('cursor');
    const page = await ctx.client.get<AuditPage>(url(search));
    events.push(...page.events);
    nextCursor = page.next_cursor;
    if (!all || !nextCursor) break;
    if (seen.has(nextCursor)) {
      throw new Error('audit pagination returned a repeated continuation cursor');
    }
    seen.add(nextCursor);
    cursor = nextCursor;
  }

  if (json) {
    emitJson({ events, next_cursor: all ? null : nextCursor });
    return 0;
  }
  printEvents(events);
  if (footer === 'session') {
    // An empty session timeline ends at the table's own closing blank line.
    if (events.length === 0) return 0;
    if (nextCursor && !all) {
      process.stdout.write(
        `\n  ${C.dim}more available — use --all, or --cursor ${nextCursor}${C.reset}`,
      );
    }
    process.stdout.write('\n');
    return 0;
  }
  process.stdout.write(
    `\n  ${C.dim}${events.length} event${events.length === 1 ? '' : 's'}${C.reset}`,
  );
  if (nextCursor && !all) {
    process.stdout.write(
      footer === 'project'
        ? `  ${C.dim}more available — use --all${C.reset}`
        : `  ${C.dim}more available — use --all, or --cursor ${nextCursor}${C.reset}`,
    );
  }
  process.stdout.write('\n\n');
  return 0;
}

export async function runAudit(argv: string[]): Promise<number> {
  const helpCode = splitHelp(argv, HELP);
  if (helpCode !== null) return helpCode;
  const sub = argv[0];
  const rest = argv.slice(1);
  const f: Record<string, string | undefined> = {};
  let json = false;
  let all = false;
  try {
    f.account = takeFlagValue(rest, ['--account']);
    f.host = takeFlagValue(rest, ['--host']);
    f.action = takeFlagValue(rest, ['--action']);
    f.actor = takeFlagValue(rest, ['--actor']);
    f.actorType = takeFlagValue(rest, ['--actor-type']);
    f.project = takeFlagValue(rest, ['--project']);
    f.session = takeFlagValue(rest, ['--session']);
    f.source = takeFlagValue(rest, ['--source']);
    f.credentialKind = takeFlagValue(rest, ['--credential-kind']);
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
    return fail((err as Error).message);
  }
  const positional = rest.filter((a) => !a.startsWith('-'));

  const ctx = resolveAccountContext({ accountArg: f.account, hostArg: f.host });
  if (!ctx) return 1;
  const base = `/accounts/${ctx.accountId}/audit`;

  try {
    switch (sub) {
      case 'ls':
      case 'list':
        return await listAuditEvents(ctx, (search) => `${base}?${search}`, f, all, json, 'ls');

      case 'project': {
        const projectId = positional[0] ?? f.project;
        if (!projectId) return fail('Missing a project id.');
        return await listAuditEvents(
          ctx,
          (search) => `/projects/${encodeURIComponent(projectId)}/audit?${search}`,
          { ...f, project: undefined },
          all,
          json,
          'project',
        );
      }

      case 'export': {
        const built = buildAuditQuery(f);
        if ('error' in built) return fail(built.error);
        const format = (f.format || 'csv').toLowerCase();
        if (format !== 'csv' && format !== 'jsonl') return fail('--format must be csv or jsonl.');
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
                | 'anonymous'
                | undefined,
              source: search.get('source') ?? undefined,
              credential_kind: search.get('credential_kind') ?? undefined,
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
        if (!sessionId) return fail('Missing a session id.');
        const projectId = f.project;
        if (!projectId)
          return missing('--project <id> — the session audit route is project-scoped');
        return await listAuditEvents(
          ctx,
          (search) =>
            `/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/audit${search.size ? `?${search}` : ''}`,
          f,
          all,
          json,
          'session',
        );
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
                `  ${pad(w.name, nameW)}   ${pad(trim(w.url, urlW), urlW)}   ${pad(state, 8)}   ` +
                  `${pad(w.action_prefix ?? 'all', 12)}   ${C.faded}${w.webhook_id}${C.reset}\n`,
              );
              if (w.last_error) {
                process.stdout.write(
                  `  ${C.red}└ last error${C.reset} ${C.dim}${w.last_error_at?.slice(0, 19).replace('T', ' ') ?? ''}${C.reset} ${trim(w.last_error, 80)}\n`,
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
            if (!f.name) return missing('--name <label>');
            if (!f.url) return missing('--url <https endpoint>');
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
            if (!webhookId) return missing('a webhook id (see `kortix audit webhooks ls`)');
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
            if (!webhookId) return missing('a webhook id (see `kortix audit webhooks ls`)');
            await ctx.client.delete(`${base}/webhooks/${encodeURIComponent(webhookId)}`);
            process.stdout.write(
              `${status.ok(`Deleted webhook ${C.bold}${webhookId}${C.reset}`)}\n`,
            );
            return 0;
          }

          default:
            return fail(`unknown webhooks verb "${verb}" — use ls|add|enable|disable|rm`);
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
