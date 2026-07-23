/**
 * Harness-neutral resolution for a persisted session's model override.
 *
 * `project_sessions.metadata` is a free-form JSON blob. Every WRITE path now
 * persists the neutral `model` key (see `createProjectSession` in
 * `./sessions.ts`), but ~400k already-persisted session rows were written
 * before that rename and still carry ONLY the legacy `opencode_model` key.
 * Every READ path must therefore dual-read: prefer `model`, fall back to
 * `opencode_model`. Never drop the fallback — that would silently strand
 * every pre-rename session's model override.
 *
 * This is the single source of truth for that precedence so
 * `session-lifecycle/actions.ts`, `repositories/model-preferences.ts`, and
 * `projects/routes/shared.ts` can never drift out of sync with each other.
 */
export function resolveSessionMetadataModel(
  metadata: Record<string, unknown> | null | undefined,
): string | null {
  if (!metadata) return null;
  if (typeof metadata.model === 'string') return metadata.model;
  if (typeof metadata.opencode_model === 'string') return metadata.opencode_model;
  return null;
}
