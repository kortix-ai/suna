/**
 * Approval enrichment: a call whose arguments only name a target
 * (`gmail.send_draft {draft_id}`) asks a human to approve content they never
 * see. An enricher performs ONE read-only provider call when the call is held
 * for approval and returns the content the call will act on. The gateway
 * stores it redacted (`result_summary.resolved_preview`) and binds the
 * approval to its digest (`resolved_digest`): a carried-over approval whose
 * content changed asks again (`content_changed`).
 */
import { buildArgsPreviewDetails } from './args-preview';
import type { CallInput, GatewayConnector, GatewayDeps } from './gateway';
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

/**
 * Keyed by `enricherKey`. Ships empty.
 * ponytail: no enricher registered yet. Follow-up: a Gmail send-draft fetcher
 * (`composio:GMAIL_SEND_DRAFT` via `GMAIL_LIST_DRAFTS` filtered by `draft_id`,
 * and/or the Gmail MCP server's get-draft tool), mapped to
 * `{to, cc, bcc, subject, body, attachments}` and verified against a real
 * connected mailbox. Composio has no get-draft tool (catalog, 2026-10-20).
 */
export const APPROVAL_ENRICHERS: Readonly<Record<string, ApprovalEnricher>> = {};

export const APPROVAL_ENRICH_TIMEOUT_MS = 3_000;

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
