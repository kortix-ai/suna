/**
 * Shell-mode detection — a turn is "shell mode" when the user message is
 * entirely synthetic text and the single assistant response is a bare bash
 * tool call, rendered as a terminal instead of a normal chat turn.
 *
 * Split out of `turns/index.ts` — see that file's history for the original
 * single-file version. No React / DOM / framework imports allowed.
 */

import type { MessageWithPartsLike, PartLike, ToolPartLike, TurnLike } from './types';
import { isTextPart, isToolPart } from './parts';

// ============================================================================
// Internal wire shapes (structural casts, never exported)
// ============================================================================

interface TextPartLike extends PartLike {
  type: 'text';
  text?: string;
  synthetic?: boolean;
}

// ============================================================================
// Shell mode detection
// ============================================================================

/**
 * Detect "shell mode": user message is entirely synthetic text parts AND
 * there's exactly one assistant message with exactly one part which is a bash tool.
 *
 * Stricter than our previous implementation — matches SolidJS session-turn.tsx:364-379
 * which checks `msgParts.length !== 1` (exactly one assistant part total).
 */
export function isShellMode(turn: TurnLike): boolean {
  const userParts = turn.userMessage.parts;
  if (userParts.length === 0) return false;
  const allSynthetic = userParts.every(
    (p) => isTextPart(p) && (p as PartLike as TextPartLike).synthetic,
  );
  if (!allSynthetic) return false;

  if (turn.assistantMessages.length !== 1) return false;
  const assistantParts = turn.assistantMessages[0].parts;
  // Strict: exactly 1 part total (not just 1 tool part)
  if (assistantParts.length !== 1) return false;
  const part = assistantParts[0];
  return isToolPart(part) && (part as PartLike as ToolPartLike).tool === 'bash';
}

/** Get the bash tool part when in shell mode. */
export function getShellModePart<M extends MessageWithPartsLike>(
  turn: TurnLike<M>,
): (M['parts'][number] & { type: 'tool' }) | undefined {
  if (!isShellMode(turn)) return undefined;
  return turn.assistantMessages[0].parts[0] as M['parts'][number] & { type: 'tool' };
}
