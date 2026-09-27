/**
 * The two-step confirmation on the Delete account screen
 * (app/(settings)/account-deletion.tsx). Pure functions, tested in
 * confirm-flow.test.mts.
 *
 * 1. `type`: the user types the confirm word (DELETE). Continue stays
 *    disabled until it matches.
 * 2. `final`: "Are you sure? Everything will be deleted." The Delete button
 *    arms only after `FINAL_CONFIRM_ARM_DELAY_MS`, so a double tap on Continue
 *    lands on a disabled button and cannot also delete the account.
 *
 * No path deletes on taps alone: every deletion needs the typed word, a
 * Continue, a pause, and a second, separate Delete.
 */

export type DeleteConfirmStep = 'type' | 'final';

/** How long the final Delete button stays disabled after the second question appears. */
export const FINAL_CONFIRM_ARM_DELAY_MS = 1000;

/** The typed text matches the confirm word: trimmed, case-insensitive, never empty. */
export function matchesConfirmWord(input: string, word: string): boolean {
  const expected = word.trim().toLocaleUpperCase();
  return expected.length > 0 && input.trim().toLocaleUpperCase() === expected;
}

/** Continue (step 1 → 2) is enabled once the confirm word is typed. */
export function canContinueToFinal({
  input,
  word,
  busy,
}: {
  input: string;
  word: string;
  busy: boolean;
}): boolean {
  return !busy && matchesConfirmWord(input, word);
}

/** Delete (step 2) is enabled on the final step, once armed, with the word still typed. */
export function canConfirmDeletion({
  step,
  input,
  word,
  armed,
  busy,
}: {
  step: DeleteConfirmStep;
  input: string;
  word: string;
  armed: boolean;
  busy: boolean;
}): boolean {
  return step === 'final' && armed && !busy && matchesConfirmWord(input, word);
}
