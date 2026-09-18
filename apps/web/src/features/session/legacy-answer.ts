/**
 * Legacy Suna answer tools: `complete` and `ask`.
 *
 * A Suna (agentpress) agent ended a run by calling `complete`, or paused for
 * the user by calling `ask`. Both carry the answer IN THE ARGUMENTS:
 *
 *   { text: string, attachments?: string | string[], follow_up_prompts?: string[] }
 *
 * The tool result is only `{"status": "complete"}`. A migrated legacy
 * transcript therefore holds the whole final answer inside a tool part, and a
 * generic tool row hides it behind a collapsed "Complete" disclosure. These
 * helpers extract the payload so the chat can render it as a deliverable, the
 * same way it renders `show`.
 *
 * Attachment paths are relative to the legacy sandbox root `/workspace`.
 */

export const LEGACY_ANSWER_TOOLS: ReadonlySet<string> = new Set(['complete', 'ask']);

const LEGACY_WORKSPACE_ROOT = '/workspace';

export function isLegacyAnswerTool(toolName: string | undefined): boolean {
  return LEGACY_ANSWER_TOOLS.has((toolName ?? '').trim().toLowerCase());
}

export type LegacyAttachment =
  | { type: 'file'; path: string; title: string }
  | { type: 'url'; url: string; title: string };

export interface LegacyAnswerPayload {
  text: string;
  attachments: LegacyAttachment[];
  followUps: string[];
}

/** A JSON-encoded array, a comma-separated list, or a real array → trimmed strings. */
function stringList(raw: unknown, splitCommas: boolean): string[] {
  let value = raw;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('[')) {
      try {
        value = JSON.parse(trimmed);
      } catch {
        // Not JSON after all: treat it as a plain string below.
      }
    }
  }
  const items = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? splitCommas
        ? value.split(',')
        : [value]
      : [];
  return items
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
}

/** A legacy attachment reference → an absolute sandbox path or an http(s) URL. */
export function legacyAttachment(ref: string): LegacyAttachment | null {
  const trimmed = ref.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) {
    return { type: 'url', url: trimmed, title: trimmed };
  }
  const relative = trimmed.replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  if (!relative) return null;
  const path = relative.startsWith('/')
    ? relative
    : relative === 'workspace' || relative.startsWith('workspace/')
      ? `/${relative}`
      : `${LEGACY_WORKSPACE_ROOT}/${relative}`;
  const title = path.split('/').filter(Boolean).pop();
  if (!title || path === LEGACY_WORKSPACE_ROOT) return null;
  return { type: 'file', path, title };
}

/**
 * The renderable payload of a `complete` / `ask` call, or `null` when the input
 * does not have that shape. `null` lets an unrelated tool that happens to share
 * the name fall back to the generic row.
 */
export function legacyAnswerPayload(input: unknown): LegacyAnswerPayload | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  const text = typeof record.text === 'string' ? record.text.trim() : '';
  const seen = new Set<string>();
  const attachments = stringList(record.attachments, true)
    .map(legacyAttachment)
    .filter((item): item is LegacyAttachment => {
      if (!item) return false;
      const key = item.type === 'file' ? item.path : item.url;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const followUps = stringList(record.follow_up_prompts, false);
  if (!text && attachments.length === 0) return null;
  return { text, attachments, followUps };
}

/**
 * A tool part that is a legacy Suna answer: named `complete` / `ask`, with an
 * answer payload, and without the `questions` array of the live `question`
 * tool (which is also registered under `ask`).
 */
export function isLegacyAnswerPart(part: {
  tool?: string;
  state?: { input?: unknown } | null;
}): boolean {
  if (!isLegacyAnswerTool(part.tool)) return false;
  const input = part.state?.input;
  if (input && typeof input === 'object' && 'questions' in input) return false;
  return legacyAnswerPayload(input) !== null;
}

/**
 * The `show` input that renders these attachments: one item as a single card,
 * several as a carousel. `null` when there is nothing to show.
 */
export function legacyAttachmentsShowInput(
  attachments: readonly LegacyAttachment[],
): Record<string, unknown> | null {
  if (attachments.length === 0) return null;
  if (attachments.length === 1) return { ...attachments[0] };
  return { items: attachments.map((item) => ({ ...item })) };
}
