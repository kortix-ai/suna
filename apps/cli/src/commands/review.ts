import { FEATURE_DISABLED_CODE } from '@kortix/sdk';

import {
  emitJson,
  resolveProjectContext,
  surfaceApiError,
  takeFlagBool,
  takeFlagValue,
} from '../command-helpers.ts';
import { C, help, pad, status } from '../style.ts';

// `kortix review` — the CLI face of the Review Center, the per-project
// human-in-the-loop inbox (apps/web/src/features/review-center).
//
// One queue, three sources, and the id says which:
//   `cr:<id>`    a Change Request, folded in by an adapter. Its verdict routes
//                to the CR flow (merge / close / request-changes) — the native
//                /act endpoint answers 409 "act on this item from its source
//                view" for these ids by design.
//   `call:<id>`  a connector tool call a policy gated as `require_approval`.
//                Its verdict routes to POST /approvals/:executionId.
//   anything else  a native row (output / decision / batch an agent submitted).
//
// The routing is the same rule the web uses (review-actions.ts:
// connectorCallId / crChangeRequestId / planBulkAction). Keep them in step.

const SEGMENTS = ['needs_you', 'waiting', 'done'] as const;
const KINDS = ['change', 'approval', 'output', 'decision', 'batch'] as const;
const SUBMIT_KINDS = ['output', 'decision', 'batch'] as const;
const VERDICTS = ['approve', 'reject', 'changes', 'answer', 'dismiss'] as const;
const RISKS = ['none', 'low', 'medium', 'high'] as const;

type Segment = (typeof SEGMENTS)[number];
type Kind = (typeof KINDS)[number];
type Verdict = (typeof VERDICTS)[number];

const CR_PREFIX = 'cr:';
const CALL_PREFIX = 'call:';

interface ReviewItem {
  review_item_id: string;
  project_id: string;
  origin_session_id: string | null;
  kind: Kind;
  status: string;
  risk: (typeof RISKS)[number];
  source: string;
  title: string;
  summary: string;
  detail: Record<string, unknown>;
  agent: string;
  acted_by: string | null;
  acted_at: string | null;
  feedback: string | null;
  created_at: string;
  updated_at: string;
}

const HELP = help`Usage: kortix review <subcommand> [options]

The project's review inbox — everything waiting on a human decision: change
requests, connector tool calls a policy gated for approval, and the outputs,
decisions and batches agents submit for sign-off. Mirrors the dashboard's
Review Center.

Gated by the \`review_center\` feature flag. Turn it on with
\`kortix projects features enable review_center\`.

Subcommands:
  ls [--segment <s>] [--kind <k>]   List inbox items. Default: every segment.
     [--json]
  show <item-id> [--json]           Show one item in full.
  act <item-id> <verdict>           Decide one item. --message carries the note.
      [--message <text>]
  bulk <verdict> <id> [<id> …]      Decide several NATIVE items in one call.
  submit --kind <k> --title <t>     Submit an output, decision, or batch for
         [options]                  review. Needs project.review.submit.

Verdicts: ${VERDICTS.join(', ')}.
Segments: ${SEGMENTS.join(', ')}.   Kinds: ${KINDS.join(', ')}.

Where a verdict lands, by item id:
  cr:<id>     approve = merge the change, reject = close it, changes = send the
              note back to the agent that opened it (--message required).
  call:<id>   approve = let the tool call run, reject = deny it. A connector
              approval takes no other verdict — read its arguments first with
              \`kortix review show\`.
  otherwise   the native act endpoint, which takes every verdict.

\`bulk\` acts on native ids only. A connector approval needs its own parameter
review and a change request needs its diff in view, so both are reported and
skipped — same rule as the dashboard's multi-select.

Submit options:
  --kind <k>         ${SUBMIT_KINDS.join(' | ')} (required).
  --title <text>     One-line title (required).
  --summary <text>   The body a reviewer reads.
  --risk <r>         ${RISKS.join(' | ')} (default: none).
  --detail <json>    Structured payload, a JSON object.
  --agent <name>     Which agent produced it.
  --session <id>     Originating session. Ignored when it is not this
                     project's session.

Global options:
  --project <id>     Operate on this project id (default: linked).
  --host <name>      Operate against a non-default Kortix host.
  --json             Machine-readable output.
  -h, --help         Show this help.

Reads need project.review.read, verdicts need project.review.act, and
\`submit\` needs project.review.submit.

Examples:
  kortix review ls --segment needs_you
  kortix review show cr:4d5e…
  kortix review act cr:4d5e… changes --message "Rename the flag first"
  kortix review bulk dismiss rv_1 rv_2
  kortix review submit --kind decision --title "Ship v2 pricing" --risk medium
`;

export async function runReview(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    process.stdout.write(HELP);
    return argv.length === 0 ? 2 : 0;
  }

  const sub = argv[0];
  const rest = argv.slice(1);
  // The root help promises `kortix <cmd> <subcommand> --help`. None of the
  // subcommands below own dedicated help text, so without this a bare
  // `--help` falls through as an ordinary positional arg and the command
  // runs (or fails on auth) instead of printing usage.
  if (rest.includes('-h') || rest.includes('--help')) {
    process.stdout.write(HELP);
    return 0;
  }
  const f: Record<string, string | undefined> = {};
  let json = false;
  try {
    json = takeFlagBool(rest, ['--json']);
    f.project = takeFlagValue(rest, ['--project']);
    f.host = takeFlagValue(rest, ['--host']);
    f.segment = takeFlagValue(rest, ['--segment']);
    f.kind = takeFlagValue(rest, ['--kind']);
    f.message = takeFlagValue(rest, ['--message', '--feedback', '-m']);
    f.title = takeFlagValue(rest, ['--title']);
    f.summary = takeFlagValue(rest, ['--summary']);
    f.risk = takeFlagValue(rest, ['--risk']);
    f.detail = takeFlagValue(rest, ['--detail']);
    f.agent = takeFlagValue(rest, ['--agent']);
    f.session = takeFlagValue(rest, ['--session']);
  } catch (err) {
    process.stderr.write(`${status.err((err as Error).message)}\n`);
    return 2;
  }
  const positional = rest.filter((a) => !a.startsWith('-'));

  switch (sub) {
    case 'ls':
    case 'list':
      return reviewLs(f, json);
    case 'show':
    case 'info':
      return reviewShow(positional[0], f, json);
    case 'act':
      return reviewAct(positional[0], positional[1], f, json);
    case 'bulk':
      return reviewBulk(positional[0], positional.slice(1), f, json);
    case 'submit':
    case 'new':
      return reviewSubmit(f, json);
    default:
      process.stderr.write(`${status.err(`unknown subcommand "${sub}"`)}\n\n${HELP}`);
      return 2;
  }
}

// ── subcommands ────────────────────────────────────────────────────────────

async function reviewLs(
  f: Record<string, string | undefined>,
  json: boolean,
): Promise<number> {
  if (f.segment && !(SEGMENTS as readonly string[]).includes(f.segment)) {
    return invalid(`--segment must be one of ${SEGMENTS.join(', ')}`);
  }
  if (f.kind && !(KINDS as readonly string[]).includes(f.kind)) {
    return invalid(`--kind must be one of ${KINDS.join(', ')}`);
  }
  const ctx = await resolveProjectContext({ projectArg: f.project, hostArg: f.host });
  if (!ctx) return 1;

  const query = new URLSearchParams();
  if (f.segment) query.set('segment', f.segment);
  if (f.kind) query.set('kind', f.kind);
  const qs = query.toString();

  let resp: { review_items: ReviewItem[] };
  try {
    resp = await ctx.client.get<{ review_items: ReviewItem[] }>(
      `/projects/${ctx.projectId}/review/items${qs ? `?${qs}` : ''}`,
    );
  } catch (err) {
    return reviewApiError(err);
  }

  if (json) {
    emitJson(resp);
    return 0;
  }
  const items = resp.review_items;
  if (items.length === 0) {
    process.stdout.write(
      `  ${C.dim}Nothing in the inbox${f.segment ? ` for ${f.segment}` : ''}${f.kind ? ` (kind ${f.kind})` : ''}.${C.reset}\n`,
    );
    return 0;
  }
  const idW = Math.max(...items.map((i) => i.review_item_id.length), 2);
  const kindW = Math.max(...items.map((i) => i.kind.length), 4);
  const statusW = Math.max(...items.map((i) => i.status.length), 6);
  process.stdout.write('\n');
  process.stdout.write(
    `  ${C.dim}${pad('ID', idW)}   ${pad('KIND', kindW)}   ${pad('STATUS', statusW)}   ${pad('RISK', 6)}   TITLE${C.reset}\n`,
  );
  for (const item of items) {
    process.stdout.write(
      `  ${C.faded}${pad(item.review_item_id, idW)}${C.reset}   ${pad(item.kind, kindW)}   ${pad(item.status, statusW)}   ${pad(riskCell(item.risk), 6)}   ${item.title}\n`,
    );
  }
  process.stdout.write(
    `\n  ${C.dim}${items.length} item${items.length === 1 ? '' : 's'}${C.reset}\n\n`,
  );
  return 0;
}

async function reviewShow(
  id: string | undefined,
  f: Record<string, string | undefined>,
  json: boolean,
): Promise<number> {
  if (!id) return missing('a review item id');
  const ctx = await resolveProjectContext({ projectArg: f.project, hostArg: f.host });
  if (!ctx) return 1;

  let item: ReviewItem | null = null;
  try {
    if (adaptedSource(id)) {
      // A `cr:` / `call:` row has its source of truth in another table; the
      // per-item GET only reads native rows and would 404. The list endpoint is
      // where the adapters fold them in, so read it from there.
      const { review_items } = await ctx.client.get<{ review_items: ReviewItem[] }>(
        `/projects/${ctx.projectId}/review/items`,
      );
      item = review_items.find((row) => row.review_item_id === id) ?? null;
      if (!item) {
        process.stderr.write(`${status.err(`No review item "${id}" in the inbox.`)}\n`);
        return 1;
      }
    } else {
      const resp = await ctx.client.get<{ review_item: ReviewItem }>(
        `/projects/${ctx.projectId}/review/items/${encodeURIComponent(id)}`,
      );
      item = resp.review_item;
    }
  } catch (err) {
    return reviewApiError(err);
  }

  if (json) {
    emitJson(item);
    return 0;
  }
  const rows: Array<[string, string]> = [
    ['id', item.review_item_id],
    ['kind', item.kind],
    ['status', item.status],
    ['risk', riskCell(item.risk)],
    ['source', item.source],
    ['agent', item.agent || '—'],
    ['session', item.origin_session_id ?? '—'],
    ['created', item.created_at],
  ];
  if (item.acted_at) rows.push(['acted', `${item.acted_at}${item.acted_by ? ` by ${item.acted_by}` : ''}`]);
  if (item.feedback) rows.push(['feedback', item.feedback]);
  const labelW = Math.max(...rows.map(([label]) => label.length)) + 1;

  process.stdout.write(`\n  ${C.bold}${item.title}${C.reset}\n`);
  if (item.summary) process.stdout.write(`  ${item.summary.replace(/\n/g, '\n  ')}\n`);
  process.stdout.write('\n');
  for (const [label, value] of rows) {
    process.stdout.write(`  ${C.dim}${pad(label, labelW)} ${C.reset}${value}\n`);
  }
  if (Object.keys(item.detail ?? {}).length > 0) {
    process.stdout.write(`\n  ${C.dim}detail${C.reset}\n`);
    process.stdout.write(
      `${JSON.stringify(item.detail, null, 2)
        .split('\n')
        .map((line) => `    ${line}`)
        .join('\n')}\n`,
    );
  }
  process.stdout.write(`\n  ${C.dim}Decide it: ${C.reset}${C.cyan}kortix review act ${item.review_item_id} approve${C.reset}\n\n`);
  return 0;
}

async function reviewAct(
  id: string | undefined,
  verdictArg: string | undefined,
  f: Record<string, string | undefined>,
  json: boolean,
): Promise<number> {
  if (!id) return missing('a review item id');
  if (!verdictArg) return missing(`a verdict: ${VERDICTS.join(' | ')}`);
  const verdict = verdictArg as Verdict;
  if (!(VERDICTS as readonly string[]).includes(verdict)) {
    return invalid(`verdict must be one of ${VERDICTS.join(', ')}`);
  }
  const ctx = await resolveProjectContext({ projectArg: f.project, hostArg: f.host });
  if (!ctx) return 1;
  const base = `/projects/${ctx.projectId}`;

  try {
    // ── A connector approval: one live question to the agent. Approve lets the
    //    call run, reject denies it. Nothing else is a decision on that call.
    const executionId = strip(id, CALL_PREFIX);
    if (executionId) {
      if (verdict !== 'approve' && verdict !== 'reject') {
        process.stderr.write(
          `${status.err(`A connector approval takes approve or reject — not "${verdict}".`)}\n` +
            `  ${C.dim}Read its arguments first: ${C.reset}${C.cyan}kortix review show ${id}${C.reset}\n`,
        );
        return 2;
      }
      const decision = verdict === 'approve' ? 'approve' : 'deny';
      const resp = await ctx.client.post<Record<string, unknown>>(
        `${base}/approvals/${encodeURIComponent(executionId)}`,
        { decision },
      );
      if (json) {
        emitJson({ id, decision, ...resp });
        return 0;
      }
      process.stdout.write(
        decision === 'approve'
          ? `${status.ok(`Approved ${C.bold}${id}${C.reset} — the agent continues`)}\n`
          : `${status.ok(`Denied ${C.bold}${id}${C.reset}`)}\n`,
      );
      return 0;
    }

    // ── A change request: merge / close / request-changes on its own flow. The
    //    native act endpoint 409s on a `cr:` id by design.
    const crId = strip(id, CR_PREFIX);
    if (crId) {
      if (verdict === 'approve') {
        const resp = await ctx.client.post<{
          merge: { merge_commit_sha: string; fast_forward: boolean };
        }>(`${base}/change-requests/${encodeURIComponent(crId)}/merge`, {});
        if (json) {
          emitJson(resp);
          return 0;
        }
        process.stdout.write(
          `${status.ok(`Shipped ${C.bold}${id}${C.reset} ${C.dim}(${resp.merge.fast_forward ? 'fast-forward' : '3-way merge'})${C.reset}  ${C.faded}${resp.merge.merge_commit_sha.slice(0, 7)}${C.reset}`)}\n`,
        );
        return 0;
      }
      if (verdict === 'reject') {
        const resp = await ctx.client.post<Record<string, unknown>>(
          `${base}/change-requests/${encodeURIComponent(crId)}/close`,
          {},
        );
        if (json) {
          emitJson(resp);
          return 0;
        }
        process.stdout.write(`${status.ok(`Closed ${C.bold}${id}${C.reset}`)}\n`);
        return 0;
      }
      if (verdict === 'changes') {
        const note = (f.message ?? '').trim();
        if (!note) return missing('--message "<what to change>"');
        const resp = await ctx.client.post<{ delivering: boolean }>(
          `${base}/change-requests/${encodeURIComponent(crId)}/request-changes`,
          { feedback: note },
        );
        if (json) {
          emitJson(resp);
          return 0;
        }
        process.stdout.write(
          resp.delivering
            ? `${status.ok(`Sent to the agent — it will revise ${C.bold}${id}${C.reset}`)}\n`
            : `${status.ok(`Saved on ${C.bold}${id}${C.reset}`)} ${C.dim}(no originating session to deliver to)${C.reset}\n`,
        );
        return 0;
      }
      process.stderr.write(
        `${status.err(`A change request takes approve, reject, or changes — not "${verdict}".`)}\n`,
      );
      return 2;
    }

    // ── A native row.
    const item = await ctx.client.post<ReviewItem>(
      `${base}/review/items/${encodeURIComponent(id)}/act`,
      { verdict, ...(f.message ? { feedback: f.message } : {}) },
    );
    if (json) {
      emitJson(item);
      return 0;
    }
    process.stdout.write(
      `${status.ok(`${C.bold}${item.review_item_id}${C.reset} → ${item.status}`)}\n`,
    );
    return 0;
  } catch (err) {
    return reviewApiError(err);
  }
}

async function reviewBulk(
  verdictArg: string | undefined,
  ids: string[],
  f: Record<string, string | undefined>,
  json: boolean,
): Promise<number> {
  if (!verdictArg) return missing(`a verdict: ${VERDICTS.join(' | ')}`);
  const verdict = verdictArg as Verdict;
  if (!(VERDICTS as readonly string[]).includes(verdict)) {
    return invalid(`verdict must be one of ${VERDICTS.join(', ')}`);
  }
  if (ids.length === 0) return missing('at least one review item id');

  const plan = planBulk(ids);
  const ctx = await resolveProjectContext({ projectArg: f.project, hostArg: f.host });
  if (!ctx) return 1;

  let updated = 0;
  let items: ReviewItem[] = [];
  if (plan.native.length > 0) {
    try {
      const resp = await ctx.client.post<{ updated: number; review_items: ReviewItem[] }>(
        `/projects/${ctx.projectId}/review/bulk`,
        { ids: plan.native, verdict },
      );
      updated = resp.updated;
      items = resp.review_items;
    } catch (err) {
      return reviewApiError(err);
    }
  }

  if (json) {
    emitJson({
      verdict,
      updated,
      review_items: items,
      skipped_approvals: plan.resolvable,
      skipped_changes: plan.unsupported,
    });
    return plan.native.length === 0 ? 1 : 0;
  }
  if (updated > 0) {
    process.stdout.write(
      `${status.ok(`${updated} item${updated === 1 ? '' : 's'} → ${verdict}`)}\n`,
    );
  }
  for (const id of plan.resolvable) {
    process.stdout.write(
      `${status.warn(`${id} needs its own parameter review`)} ${C.dim}— ${C.reset}${C.cyan}kortix review show ${id}${C.reset}\n`,
    );
  }
  for (const id of plan.unsupported) {
    process.stdout.write(
      `${status.warn(`${id} has no bulk path — ship it with its diff in view`)} ${C.dim}— ${C.reset}${C.cyan}kortix review act ${id} ${verdict}${C.reset}\n`,
    );
  }
  // Nothing was decided: the caller asked for an action that did not happen.
  return plan.native.length === 0 ? 1 : 0;
}

async function reviewSubmit(
  f: Record<string, string | undefined>,
  json: boolean,
): Promise<number> {
  if (!f.kind) return missing(`--kind ${SUBMIT_KINDS.join('|')}`);
  if (!(SUBMIT_KINDS as readonly string[]).includes(f.kind)) {
    return invalid(`--kind must be one of ${SUBMIT_KINDS.join(', ')}`);
  }
  if (!f.title) return missing('--title "<text>"');
  if (f.risk && !(RISKS as readonly string[]).includes(f.risk)) {
    return invalid(`--risk must be one of ${RISKS.join(', ')}`);
  }
  let detail: Record<string, unknown> | undefined;
  if (f.detail !== undefined) {
    try {
      const parsed: unknown = JSON.parse(f.detail);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return invalid('--detail must be a JSON object');
      }
      detail = parsed as Record<string, unknown>;
    } catch {
      return invalid('--detail must be valid JSON');
    }
  }

  const ctx = await resolveProjectContext({ projectArg: f.project, hostArg: f.host });
  if (!ctx) return 1;

  // Inside a sandbox the agent already knows which session it runs in.
  const sessionId = f.session ?? process.env.KORTIX_SESSION_ID;

  let item: ReviewItem;
  try {
    item = await ctx.client.post<ReviewItem>(`/projects/${ctx.projectId}/review/items`, {
      kind: f.kind,
      title: f.title,
      ...(f.summary ? { summary: f.summary } : {}),
      ...(f.risk ? { risk: f.risk } : {}),
      ...(detail ? { detail } : {}),
      ...(f.agent ? { agent: f.agent } : {}),
      ...(sessionId ? { session_id: sessionId } : {}),
    });
  } catch (err) {
    return reviewApiError(err);
  }

  if (json) {
    emitJson(item);
    return 0;
  }
  process.stdout.write(
    `${status.ok(`Submitted ${C.bold}${item.title}${C.reset} for review`)}\n` +
      `  ${C.faded}${item.review_item_id}${C.reset} ${C.dim}— ${item.status}${C.reset}\n`,
  );
  return 0;
}

// ── id routing (mirrors apps/web/src/features/review-center/review-actions.ts) ─

/** Strip a namespace prefix, or null when `id` does not carry it. */
function strip(id: string, prefix: string): string | null {
  return id.startsWith(prefix) ? id.slice(prefix.length) : null;
}

export function adaptedSource(id: string): 'cr' | 'call' | null {
  if (id.startsWith(CR_PREFIX)) return 'cr';
  if (id.startsWith(CALL_PREFIX)) return 'call';
  return null;
}

export interface BulkPlan {
  /** Ids the bulk endpoint can act on. */
  native: string[];
  /** Connector approvals — each needs its own parameter review. */
  resolvable: string[];
  /** Change requests — merging needs the diff in view, so there is no bulk path. */
  unsupported: string[];
}

export function planBulk(ids: Iterable<string>): BulkPlan {
  const native: string[] = [];
  const resolvable: string[] = [];
  const unsupported: string[] = [];
  for (const id of ids) {
    const source = adaptedSource(id);
    if (source === 'call') resolvable.push(id);
    else if (source === 'cr') unsupported.push(id);
    else native.push(id);
  }
  return { native, resolvable, unsupported };
}

// ── helpers ────────────────────────────────────────────────────────────────

/**
 * Surface an API error, adding the one command that clears a `feature_disabled`
 * 403. The server's prose points at the dashboard's Settings → Feature flags;
 * a CLI caller needs the CLI verb.
 */
function reviewApiError(err: unknown): number {
  const code = (err as { body?: { code?: unknown } } | null)?.body?.code;
  const exit = surfaceApiError(err);
  if (code === FEATURE_DISABLED_CODE) {
    process.stderr.write(
      `  ${C.dim}Turn it on: ${C.reset}${C.cyan}kortix projects features enable review_center${C.reset}\n`,
    );
  }
  return exit;
}

function riskCell(risk: string): string {
  if (risk === 'high') return `${C.red}high${C.reset}`;
  if (risk === 'medium') return `${C.yellow}medium${C.reset}`;
  if (risk === 'low') return `${C.faded}low${C.reset}`;
  return `${C.faded}none${C.reset}`;
}

function missing(what: string): number {
  process.stderr.write(`${status.err(`Pass ${what}.`)}\n`);
  return 2;
}

function invalid(message: string): number {
  process.stderr.write(`${status.err(message)}\n`);
  return 2;
}
