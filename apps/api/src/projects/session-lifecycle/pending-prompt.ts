/**
 * `pending_prompt` → durable inbox row, at session create and warm claim.
 *
 * The first prompt of a new session used to travel client-side: the producer
 * stashed it in sessionStorage, navigated, and the workbench replayed it once
 * the runtime answered — a 19-25s window (measured boot) in which a closed
 * tab, a crash, or a navigation lost the message silently. The server already
 * received the text at create time (`create.pending_prompt`); this makes it a
 * durable `session_lifecycle_commands` row in the SAME transaction as the
 * session row, so the wake-then-deliver machinery runs it even if the tab
 * closes before the page ever mounts.
 *
 * The stored metadata keeps ONLY the picks (`agent`, `model`, `variant`,
 * `attachment_names`): a pre-deploy web bundle replays `pending_prompt.text`
 * client-side, and stripping the text is what makes old-web + new-API safe
 * from a double send. New web seeds its model/agent stores from the picks and
 * POSTs nothing.
 */

import { buildContinueSessionCommandValues } from './store';
import { flattenPromptText, sanitizeInboxPromptParts } from './prompt-parts';
import { mintWireMessageId } from '../wire-message-id';

export interface PendingPromptConversion {
  /** Insert values for `session_lifecycle_commands`, or null when the prompt
   *  has no content (metadata-only hand-off — picks still stored). */
  rowValues: ReturnType<typeof buildContinueSessionCommandValues> | null;
  /** What `metadata.pending_prompt` stores instead of the full hand-off. */
  metadataPicks: Record<string, unknown>;
  /** A part-level refusal (size cap, malformed list). The caller maps it to a
   *  400 rather than silently dropping an attachment. */
  error: string | null;
}

export function convertPendingPromptToInboxRow(input: {
  pendingPrompt: Record<string, unknown>;
  projectId: string;
  accountId: string;
  sessionId: string;
  actorUserId: string | null;
  nowMs?: number;
}): PendingPromptConversion {
  const { pendingPrompt } = input;
  const { text: _text, parts: _parts, ...metadataPicks } = pendingPrompt;

  const text = typeof pendingPrompt.text === 'string' ? pendingPrompt.text.trim() : '';
  const rawParts = Array.isArray(pendingPrompt.parts) ? pendingPrompt.parts : [];
  const effectiveRaw = rawParts.length > 0 ? rawParts : text ? [{ type: 'text', text }] : [];
  if (effectiveRaw.length === 0) {
    return { rowValues: null, metadataPicks, error: null };
  }
  const sanitized = sanitizeInboxPromptParts(effectiveRaw);
  if ('error' in sanitized) return { rowValues: null, metadataPicks, error: sanitized.error };

  const model = pendingPrompt.model as { providerID?: unknown; modelID?: unknown } | null;
  const overrides = {
    agent: typeof pendingPrompt.agent === 'string' ? pendingPrompt.agent : null,
    model:
      model && typeof model.providerID === 'string' && typeof model.modelID === 'string'
        ? { providerID: model.providerID, modelID: model.modelID }
        : null,
    variant: typeof pendingPrompt.variant === 'string' ? pendingPrompt.variant : null,
    directory: typeof pendingPrompt.directory === 'string' ? pendingPrompt.directory : null,
  };

  const rowValues = buildContinueSessionCommandValues({
    source: 'ui',
    projectId: input.projectId,
    accountId: input.accountId,
    sessionId: input.sessionId,
    actorUserId: input.actorUserId,
    text: flattenPromptText(sanitized.parts),
    // One first prompt per session, and a create-retry dedupes into it.
    idempotencyKey: `prompt:${input.sessionId}:pending-first`,
    clientMessageId: `pending:${input.sessionId}`,
    // Minted with no transcript to place against — the drain re-mints it
    // against the live root before delivering, same as the localStorage
    // migration's rows.
    wireMessageId: mintWireMessageId({ nowMs: input.nowMs ?? Date.now() }).id,
    remintOnDelivery: true,
    parts: sanitized.parts,
    overrides,
  });
  return { rowValues, metadataPicks, error: null };
}
