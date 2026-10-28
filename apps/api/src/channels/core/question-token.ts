/**
 * A question button's data, without the database graph of questions.ts, so a
 * card builder can import it.
 */
import { isUuid } from '../../shared/validate';

/**
 * `kq:<question row id>:<option index>` for the first question (at most 42
 * bytes, so it fits a 64-byte button payload), `kq:<id>:<question>.<option>`
 * for a later one (at most 45 bytes). Persisted in chats: never change the format.
 */
export function questionButtonData(pendingId: string, option: number, question = 0): string {
  return `kq:${pendingId}:${question ? `${question}.` : ''}${option}`;
}

/** The question and option a button names, or null for a button Kortix did not post. */
export function parseQuestionButton(data: string): { pendingId: string; question: number; index: number } | null {
  const match = /^kq:([^:]+):(?:([1-9]\d?)\.)?(0|[1-9]\d?)$/.exec(data);
  return match && isUuid(match[1]) ? { pendingId: match[1], question: Number(match[2] ?? 0), index: Number(match[3]) } : null;
}
