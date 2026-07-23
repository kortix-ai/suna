export function isAcpPromptEnvelope(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const envelope = value as Record<string, unknown>;
  return envelope.jsonrpc === '2.0'
    && Object.prototype.hasOwnProperty.call(envelope, 'id')
    && envelope.method === 'session/prompt';
}

export type AcpHarnessTitleUpdate = {
  title: string;
  /** ISO timestamp the harness stamped on this update, if it sent one — used
   *  by the persist layer for last-write-wins ordering when updates arrive
   *  out of order. */
  updatedAt: string | null;
};

/**
 * Pulls a harness-emitted title out of a `session/update` `session_info_update`
 * notification, if THIS update actually carries one.
 *
 * Verified against real persisted envelopes (`kortix.acp_session_envelopes`,
 * dev DB, 148 `session_info_update` occurrences across all four harnesses):
 * only claude-agent-acp sends `{title, updatedAt}` on this notification.
 * codex-acp and pi-acp also send `session_info_update`, but exclusively for
 * status pings — `_meta.codex.threadStatus` / `_meta.piAcp.{running,
 * queueDepth}` — never a `title` field, so this correctly returns `null` for
 * those. OpenCode's ACP mode was never observed to send `session_info_update`
 * at all (0 occurrences across 42 distinct OpenCode runtime sessions). Any
 * harness that starts sending `title` here is picked up automatically —
 * nothing here is claude-specific by construction, only by observed fact.
 */
export function extractHarnessSessionTitle(value: unknown): AcpHarnessTitleUpdate | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const envelope = value as Record<string, unknown>;
  if (envelope.method !== 'session/update') return null;
  const params = envelope.params;
  if (!params || typeof params !== 'object' || Array.isArray(params)) return null;
  const update = (params as Record<string, unknown>).update;
  if (!update || typeof update !== 'object' || Array.isArray(update)) return null;
  const updateRecord = update as Record<string, unknown>;
  if (updateRecord.sessionUpdate !== 'session_info_update') return null;
  const title = typeof updateRecord.title === 'string' ? updateRecord.title.trim() : '';
  if (!title) return null;
  const updatedAt = typeof updateRecord.updatedAt === 'string' ? updateRecord.updatedAt : null;
  return { title, updatedAt };
}

const FALLBACK_TITLE_MAX_LENGTH = 80;

/** Truncates on the nearest earlier word boundary (never mid-word) once past
 *  the max length, so the sidebar row reads as a clipped sentence, not a
 *  chopped word. Falls back to a hard cut only when there is no reasonable
 *  word boundary to use (a boundary before character 40 would clip too
 *  aggressively). */
function truncateTitle(text: string): string {
  if (text.length <= FALLBACK_TITLE_MAX_LENGTH) return text;
  const sliced = text.slice(0, FALLBACK_TITLE_MAX_LENGTH);
  const lastSpace = sliced.lastIndexOf(' ');
  const cut = lastSpace > 40 ? sliced.slice(0, lastSpace) : sliced;
  return `${cut.trimEnd()}…`;
}

/**
 * Derives a fallback title from the first text block of a `session/prompt`
 * request — the cheapest-correct substitute for the harnesses that never
 * emit a harness-generated title over ACP (codex, pi, opencode; see
 * `extractHarnessSessionTitle`'s doc comment for the evidence). Returns
 * `null` when the prompt carries no text block (e.g. image/resource-only).
 */
export function extractFallbackTitleFromPrompt(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const envelope = value as Record<string, unknown>;
  if (envelope.method !== 'session/prompt') return null;
  const params = envelope.params;
  if (!params || typeof params !== 'object' || Array.isArray(params)) return null;
  const prompt = (params as Record<string, unknown>).prompt;
  if (!Array.isArray(prompt)) return null;
  for (const block of prompt) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
    const b = block as Record<string, unknown>;
    if (b.type !== 'text' || typeof b.text !== 'string') continue;
    const collapsed = b.text.replace(/\s+/g, ' ').trim();
    if (!collapsed) continue;
    return truncateTitle(collapsed);
  }
  return null;
}
