/**
 * Pure decisions behind the in-chat connector connect/approve hand-off
 * (COR-158, connector remainder — the model-provider half is
 * `lib/session/connect-model.ts` / `components/session/ConnectProviderSheet.tsx`).
 *
 * Web's mechanism: a `kortix-connectors_call` denial for an unconnected
 * connector carries `connect_url` — an agent-minted `/connect/<token>` setup
 * link (`apps/api/src/connectors/principal-access.ts` `connectorDenialBody`,
 * `apps/api/src/connectors/db-deps.ts` `mintConnectorConnectLink`). Web's
 * markdown link interceptor turns that link into `SetupLinkButton` /
 * `ConnectorIntake` wherever the agent happens to paste it in prose. Mobile
 * has no markdown link interception, so it reads the SAME field straight off
 * the `kortix-connectors_call` tool part instead
 * (`components/session/tool/tools/connector-tools.tsx`'s `ConnectorCallTool`)
 * — the tool part is the one place this fact is guaranteed to show up.
 *
 * The connect hand-off itself prefers the project's own Pipedream connect
 * round trip (`lib/projects/projects-client.ts` `pipedreamConnect` /
 * `pipedreamFinalize`, the same one `components/pages/ConnectorsPage.tsx`
 * already uses) over opening the agent's `connect_url` directly: the
 * project-scoped flow mints a URL that supports a `kortix://` redirect, so
 * the in-app browser auto-dismisses; the public `/connect/<token>` page does
 * not, and is kept only as a fallback (`ConnectorAuthSheet`).
 *
 * A call that needs a human renders as a STANDALONE transcript row
 * (`connectorHandoffCallIds` → `standaloneCallIdsFor`, `turn-body.ts`), never
 * inside a burst's activity sheet: the Connect row and the approval prompt
 * need the transcript's `ConnectorHandoffContext`, and a sheet opened from
 * inside another sheet would stack two overlays.
 */

import { isToolPart, type Part } from '@kortix/sdk';

import { partInput, partOutput } from './tool-part-accessors';
import { parseConnectorOutput } from './tool-output-parsers';

/** "google_drive" / "gmail" → "Google Drive" / "Gmail" — a friendly fallback
 *  name from a slug. Ported from `ConnectorsPage.tsx`'s `prettifyAppName`. */
export function prettifyConnectorName(slug: string): string {
  const out = slug
    .split(/[_-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
  return out || slug;
}

export interface ConnectorConnectNeed {
  slug: string;
  label: string;
  /** The agent's own setup-link URL — a `/connect/<token>` public page. */
  connectUrl: string;
}

/**
 * A `kortix-connectors_call` denial whose remedy is "connect the app" —
 * `connectorDenialBody`'s `connector_not_connected` case is the only denial
 * reason that carries `connect_url`, so its presence is the signal, not just
 * the reason string (a future denial reason that also mints a link should
 * still show the row).
 */
export function connectorConnectNeed(
  input: Record<string, unknown>,
  parsed: Record<string, unknown> | null,
): ConnectorConnectNeed | null {
  if (!parsed) return null;
  if (parsed.ok === true) return null;
  if (parsed.status !== 'denied') return null;
  const connectUrl = typeof parsed.connect_url === 'string' ? parsed.connect_url.trim() : '';
  if (!connectUrl) return null;
  const slug = String(parsed.connector ?? input.connector ?? '').trim();
  if (!slug) return null;
  return { slug, label: prettifyConnectorName(slug), connectUrl };
}

export interface ConnectorApprovalArg {
  key: string;
  value: string;
}

export interface ConnectorApprovalNeed {
  executionId: string;
  connector: string;
  /** The action the call runs (`send_email`). Empty when neither the payload
   *  nor the tool input names one. */
  action: string;
  /** `connector.action` — what the prompt names, so the reader knows what
   *  they approve. */
  actionRef: string;
  /** The first `APPROVAL_ARGS_MAX` top-level call arguments, each value cut
   *  to `APPROVAL_ARG_VALUE_MAX` characters. */
  argsPreview: ConnectorApprovalArg[];
  summary: string | null;
  instructions: string | null;
  risk: string | null;
}

/** A `kortix-connectors_call` awaiting a human approve/deny — never a connect. */
export function connectorApprovalNeed(
  input: Record<string, unknown>,
  parsed: Record<string, unknown> | null,
): ConnectorApprovalNeed | null {
  if (!parsed) return null;
  if (parsed.status !== 'pending_approval') return null;
  const executionId = typeof parsed.execution_id === 'string' ? parsed.execution_id.trim() : '';
  if (!executionId) return null;
  const connector = String(parsed.connector ?? input.connector ?? '').trim();
  const action = String(parsed.action ?? input.action ?? '').trim();
  return {
    executionId,
    connector,
    action,
    actionRef: connector && action ? `${connector}.${action}` : connector || action,
    argsPreview: approvalArgsPreview(input.args),
    summary: typeof parsed.approval_summary === 'string' ? parsed.approval_summary : null,
    instructions:
      typeof parsed.approval_instructions === 'string' ? parsed.approval_instructions : null,
    risk: typeof parsed.risk === 'string' ? parsed.risk : null,
  };
}

export const APPROVAL_ARGS_MAX = 4;
export const APPROVAL_ARG_VALUE_MAX = 80;

function approvalArgsPreview(args: unknown): ConnectorApprovalArg[] {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return [];
  return Object.entries(args as Record<string, unknown>)
    .slice(0, APPROVAL_ARGS_MAX)
    .map(([key, raw]) => {
      let value: string;
      try {
        value = typeof raw === 'string' ? raw : (JSON.stringify(raw) ?? String(raw));
      } catch {
        value = String(raw);
      }
      if (value.length > APPROVAL_ARG_VALUE_MAX) value = `${value.slice(0, APPROVAL_ARG_VALUE_MAX - 1)}…`;
      return { key, value };
    });
}

/**
 * True for `kortix-connectors_call` under every spelling `ToolRegistry.get`
 * resolves to that renderer: `_`/`-` swapped, any case, a namespace prefix.
 */
export function isConnectorCallTool(tool: string): boolean {
  const name = tool.trim().toLowerCase().replace(/-/g, '_');
  const short = name.slice(name.lastIndexOf('/') + 1);
  return short === 'kortix_connectors_call' || short.endsWith('_kortix_connectors_call');
}

/**
 * The call ids of `kortix-connectors_call` parts that ask a human for
 * something — connect an app (`connectorConnectNeed`) or approve a call
 * (`connectorApprovalNeed`). `standaloneCallIdsFor` breaks these out of their
 * burst, so their Connect row and approval prompt render in the transcript.
 */
export function connectorHandoffCallIds(parts: ReadonlyArray<{ part: Part }>): string[] {
  const ids: string[] = [];
  for (const { part } of parts) {
    if (!isToolPart(part) || !isConnectorCallTool(part.tool)) continue;
    const parsed = parseConnectorOutput(partOutput(part));
    if (!parsed) continue;
    const input = partInput(part);
    if (connectorConnectNeed(input, parsed) || connectorApprovalNeed(input, parsed)) ids.push(part.callID);
  }
  return ids;
}

/**
 * What the in-chat approval prompt shows:
 * - `unknown`  — the review list has not loaded yet: render nothing, so a
 *   resolved call never flashes Approve / Deny;
 * - `pending`  — Approve / Deny;
 * - `approved` / `denied` — the outcome is known;
 * - `resolved` — decided elsewhere (web, the Review page, before a remount),
 *   outcome not known.
 */
export type ConnectorApprovalState = 'unknown' | 'pending' | 'approved' | 'denied' | 'resolved';

export interface ConnectorApprovalStateInput {
  executionId: string;
  /** The project's review list (`reviewKeys.list`, the query `ReviewPage`
   *  reads). The API adapts only still-pending connector calls into it, as
   *  `call:<execution_id>`. `undefined` until it loads. */
  reviewItems: ReadonlyArray<{ id: string; status: string }> | undefined;
  /** When that list was fetched (react-query `dataUpdatedAt`), epoch ms. */
  reviewFetchedAtMs: number;
  /** The review list request failed and holds no data. */
  reviewFailed: boolean;
  /** When the tool call settled, epoch ms. A list fetched before it cannot
   *  carry the call yet, so its absence proves nothing. */
  callSettledAtMs: number | null;
  /** A decision this prompt made itself (it outlives the refetch that drops
   *  the call from the list). */
  localDecision: 'approve' | 'deny' | null;
}

export function connectorApprovalState(input: ConnectorApprovalStateInput): ConnectorApprovalState {
  if (input.localDecision) return input.localDecision === 'approve' ? 'approved' : 'denied';
  if (!input.reviewItems) return input.reviewFailed ? 'pending' : 'unknown';

  const item = input.reviewItems.find((row) => row.id === `call:${input.executionId}`);
  if (item) {
    if (item.status === 'needs_you' || item.status === 'waiting') return 'pending';
    if (item.status === 'approved') return 'approved';
    if (item.status === 'rejected') return 'denied';
    return 'resolved';
  }
  // Absent from a list fetched before the call settled: too early to say.
  if (input.callSettledAtMs !== null && input.reviewFetchedAtMs <= input.callSettledAtMs) return 'pending';
  return 'resolved';
}

export function connectorHandoffCopy(providerLabel: string): { title: string; body: string } {
  return {
    title: `Connect ${providerLabel}`,
    body: "Sign in on kortix.com. You come back to this chat when it's done.",
  };
}

export function connectorHandoffToast(providerLabel: string, connected: boolean): string {
  return connected ? `${providerLabel} connected` : `${providerLabel} not connected`;
}

/**
 * Mirrors `ConnectorsPage.tsx`'s `needsConnect` (inverted): a connector
 * counts as connected once it has a stored credential. `credentialMode` is
 * always `'shared'` today, so `secretSet` alone is the whole answer — kept as
 * a function (not an inline `.secretSet` read) so the one rule has one name.
 */
export function isConnectorConnected(
  connector: { secretSet?: boolean } | null | undefined,
): boolean {
  return !!connector?.secretSet;
}
