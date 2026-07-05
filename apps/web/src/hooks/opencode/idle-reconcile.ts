import type { Part } from '@kortix/sdk/opencode-client';

/** Debounce window before the run-complete reconcile fires (ms). */
export const IDLE_RECONCILE_DELAY_MS = 400;

type ToolPartState = {
  status?: string;
  input?: Record<string, unknown>;
  raw?: unknown;
};

/** Narrow a part to its tool state, or undefined if it isn't a tool part. */
function readToolState(part: Part): ToolPartState | undefined {
  const p = part as { type?: string; state?: ToolPartState };
  if (p.type !== 'tool') return undefined;
  return p.state;
}

/**
 * True if any tool part in the session is still genuinely awaiting its result
 * (running, or pending WITH input/raw) — i.e. a spinner that would otherwise
 * hang after the run completes.
 *
 * Stale-pending parts (pending with empty input and no raw, abandoned when a
 * run ends abruptly) are excluded: the server reports them pending too, so a
 * refetch can't settle them, and the renderer already treats them as
 * non-spinning (see ToolPartRenderer `isStalePending`).
 *
 * Pure + data-only (takes the session's messages and the parts-by-message map)
 * so the stream-end reconcile decision is unit-testable without the event hook,
 * the SDK, or the sync store.
 */
export function hasUnsettledToolPart(
  messages: ReadonlyArray<{ id: string }>,
  partsByMessageId: Readonly<Record<string, readonly Part[] | undefined>>,
): boolean {
  for (const m of messages) {
    const parts = partsByMessageId[m.id];
    if (!parts) continue;
    for (const part of parts) {
      const state = readToolState(part);
      if (!state) continue;
      if (state.status === 'running') return true;
      if (state.status === 'pending' && (Object.keys(state.input ?? {}).length > 0 || state.raw)) {
        return true;
      }
    }
  }
  return false;
}
