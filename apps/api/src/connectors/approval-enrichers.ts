/**
 * Approval enrichment: a call whose arguments only name a target
 * (`gmail.send_draft {draft_id}`) asks a human to approve content they never
 * see. An enricher performs ONE read-only provider call when the call is held
 * for approval and returns the content the call will act on. The gateway
 * stores it redacted (`result_summary.resolved_preview`) and binds the
 * approval to its digest (`resolved_digest`): a carried-over approval whose
 * content changed asks again (`content_changed`).
 */
import { buildArgsPreviewDetails, isPlainRecord } from './args-preview';
import { type CallInput, type GatewayConnector, type GatewayDeps, runComposioAction } from './gateway';
import { contentDigest } from './request-digest';
import type { ActionBinding } from './types';
import { withTimeout } from '../shared/with-timeout';

export interface ApprovalEnricherContext {
  deps: GatewayDeps;
  input: CallInput;
  connector: GatewayConnector;
  binding: ActionBinding;
  /** The post-context-injection arguments the held call executes with. */
  args: Record<string, unknown>;
}

/** Un-redacted content the call acts on, or null when it cannot be read. */
export type ApprovalEnricher = (ctx: ApprovalEnricherContext) => Promise<Record<string, unknown> | null>;

/** One read-only Composio tool on the held call's connection: its `result`, or null. */
async function composioRead(
  ctx: ApprovalEnricherContext,
  toolSlug: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  if (ctx.binding.kind !== 'composio') return null;
  const out = await runComposioAction(ctx.deps, ctx.input, ctx.connector, { ...ctx.binding, toolSlug }, args);
  const result = out.ok && isPlainRecord(out.data) ? out.data.result : null;
  return isPlainRecord(result) ? result : null;
}

/** The connected mailbox's own address (`GMAIL_GET_PROFILE.emailAddress`). */
async function gmailSender(ctx: ApprovalEnricherContext): Promise<string | null> {
  const profile = await composioRead(ctx, 'GMAIL_GET_PROFILE', {});
  return typeof profile?.emailAddress === 'string' && profile.emailAddress ? profile.emailAddress : null;
}

/** Header lookup by case-insensitive name: Gmail stores `to`/`subject` lowercase and `From` capitalised. */
function header(headers: unknown, name: string): string {
  if (!Array.isArray(headers)) return '';
  const hit = headers.find((h) => isPlainRecord(h) && typeof h.name === 'string' && h.name.toLowerCase() === name);
  return isPlainRecord(hit) && typeof hit.value === 'string' ? hit.value : '';
}

/**
 * `GMAIL_SEND_DRAFT {draft_id}`: one `GMAIL_GET_DRAFT {draft_id, format: full}`
 * read. Shape verified against a live mailbox on 2026-10-20:
 * `result{id, message{payload{headers[{name,value}]}, messageText,
 * attachmentList[{filename}]}}`, the same message `GMAIL_LIST_DRAFTS verbose`
 * returns, without listing every draft. Volatile fields (Date, Message-Id,
 * attachment ids, timestamps) stay out of the content.
 */
async function gmailSendDraft(ctx: ApprovalEnricherContext): Promise<Record<string, unknown> | null> {
  const draftId = ctx.args.draft_id;
  if (typeof draftId !== 'string' || !draftId) return null;
  const draft = await composioRead(ctx, 'GMAIL_GET_DRAFT', { draft_id: draftId, format: 'full' });
  const message = draft?.id === draftId && isPlainRecord(draft.message) ? draft.message : null;
  if (!message) return null;
  const headers = isPlainRecord(message.payload) ? message.payload.headers : null;
  const attachments = Array.isArray(message.attachmentList) ? message.attachmentList : [];
  return {
    from: header(headers, 'from') || (await gmailSender(ctx)) || '',
    to: header(headers, 'to'),
    cc: header(headers, 'cc'),
    bcc: header(headers, 'bcc'),
    subject: header(headers, 'subject'),
    body: typeof message.messageText === 'string' ? message.messageText : '',
    attachments: attachments.flatMap((a) => (isPlainRecord(a) && typeof a.filename === 'string' && a.filename ? [a.filename] : [])),
  };
}

/**
 * `GMAIL_SEND_EMAIL`: the arguments carry the recipients, subject and body.
 * The sender is `from_email` when the call names one, else the mailbox's own
 * address.
 */
async function gmailSendEmail(ctx: ApprovalEnricherContext): Promise<Record<string, unknown> | null> {
  const named = ctx.args.from_email;
  const from = typeof named === 'string' && named ? named : await gmailSender(ctx);
  return from ? { from } : null;
}

const intOf = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) ? value : null;
const strOf = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

/**
 * `GITHUB_MERGE_A_PULL_REQUEST {owner, repo, pull_number}`: one
 * `GITHUB_GET_A_PULL_REQUEST` read. Shape verified against a live merged pull
 * request on 2026-10-21: `result` is GitHub's pull request object.
 *
 * `head_sha` is bound on purpose: a commit pushed after the approval changes
 * the digest, so a carried-over approval asks again. `mergeable` and
 * `mergeable_state` stay out: GitHub computes them lazily (null, then a
 * value), so they change between two reads of an unchanged pull request.
 * `updated_at` and comment counts change with every comment.
 */
async function githubMergePullRequest(ctx: ApprovalEnricherContext): Promise<Record<string, unknown> | null> {
  const owner = strOf(ctx.args.owner);
  const repo = strOf(ctx.args.repo);
  const number = intOf(ctx.args.pull_number);
  if (!owner || !repo || number === null) return null;
  const pr = await composioRead(ctx, 'GITHUB_GET_A_PULL_REQUEST', { owner, repo, pull_number: number });
  if (!pr || intOf(pr.number) !== number) return null;
  const head = isPlainRecord(pr.head) ? pr.head : {};
  const base = isPlainRecord(pr.base) ? pr.base : {};
  return {
    title: strOf(pr.title) ?? '',
    number,
    state: strOf(pr.state) ?? '',
    draft: pr.draft === true,
    author: isPlainRecord(pr.user) ? (strOf(pr.user.login) ?? '') : '',
    head: strOf(head.ref) ?? '',
    base: strOf(base.ref) ?? '',
    head_sha: strOf(head.sha) ?? '',
    additions: intOf(pr.additions),
    deletions: intOf(pr.deletions),
    changed_files: intOf(pr.changed_files),
    commits: intOf(pr.commits),
  };
}

/**
 * Keyed by `enricherKey`.
 *
 * An enricher must return deterministic content: no timestamps, etags, read
 * markers or other volatile fields. The digest covers every field, so a
 * volatile one makes every carry-over a `content_changed` re-prompt.
 * The binding re-reads just before the provider call; a change in the window
 * between that read and the call is not caught (no provider offers a
 * conditional send).
 */
export const APPROVAL_ENRICHERS: Readonly<Record<string, ApprovalEnricher>> = {
  'composio:GMAIL_SEND_DRAFT': gmailSendDraft,
  'composio:GMAIL_SEND_EMAIL': gmailSendEmail,
  'composio:GITHUB_MERGE_A_PULL_REQUEST': githubMergePullRequest,
};

const APPROVAL_ENRICH_TIMEOUT_MS = 3_000;

/**
 * Provider-qualified action identity. Connector slugs are user-chosen, so a
 * provider binding names the action where it can: `composio:GMAIL_SEND_DRAFT`,
 * `pipedream:gmail-send-draft`, `mcp:<host>/<tool>`.
 */
export function enricherKey(connector: GatewayConnector, binding: ActionBinding, actionPath: string): string {
  if (binding.kind === 'composio') return `composio:${binding.toolSlug}`;
  if (binding.kind === 'pipedream') return `pipedream:${binding.actionKey}`;
  if (binding.kind === 'mcp') {
    let host = connector.slug;
    try {
      host = new URL(connector.baseUrl ?? '').host || host;
    } catch {
      /* no base URL: the slug names the server */
    }
    return `mcp:${host}/${binding.tool}`;
  }
  return `${connector.provider}:${connector.slug}.${actionPath}`;
}

export type ResolvedPreview =
  | { resolved_preview: Record<string, unknown>; resolved_digest: string }
  | { resolved_error: 'unavailable' };

/**
 * Run one enricher within the budget. Never throws: a failure, a timeout or a
 * null answer is `resolved_error: 'unavailable'`. The preview goes through
 * the same redaction and caps as `args_preview`; the digest covers the
 * un-redacted content.
 */
export async function resolveApprovalPreview(
  enricher: ApprovalEnricher,
  ctx: ApprovalEnricherContext,
  timeoutMs = APPROVAL_ENRICH_TIMEOUT_MS,
): Promise<ResolvedPreview> {
  try {
    const content = await withTimeout(enricher(ctx), timeoutMs, 'approval enrichment');
    const preview = content ? buildArgsPreviewDetails(content).preview : null;
    if (!content || !preview) return { resolved_error: 'unavailable' };
    return { resolved_preview: preview, resolved_digest: contentDigest(content) };
  } catch {
    return { resolved_error: 'unavailable' };
  }
}
