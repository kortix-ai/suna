/**
 * Proof that a forwarded prompt actually became a message.
 *
 * `POST /session/:id/prompt_async` answers for ACCEPTANCE, not for the turn:
 * 204 means "the request arrived", never "the message exists". Between the
 * drain and the runtime sits the sandbox provider's edge, which DISCARDS a
 * body over its size ceiling — and whose retry answers `200` for a request
 * OpenCode never saw. The drain read that 200 as delivery, closed the row
 * `forwarded`, and the user's prompt ceased to exist: no message, no turn, no
 * error, and an inbox row reporting success.
 *
 * Measured 2026-09-04 on a live box: bodies up to ~104 KB land, ~115 KB and
 * above are dropped; a 6.1 MB prompt (two inline JPEGs) produced `502` then
 * `200`, and the OpenCode log recorded no `prompt_async` at all.
 *
 * So delivery is confirmed by READING THE MESSAGE BACK. The write lands ~0.5 s
 * after the POST returns, so a short bounded poll costs one round trip in the
 * normal case.
 *
 * Both fallbacks lean the same way — toward "landed":
 *  - no wire id to look up: nothing to prove, so nothing is claimed;
 *  - the read itself FAILS (box mid-resume, proxy blip): absence is not
 *    established, and re-sending a prompt the runtime already took would run
 *    the user's message twice. A false "landed" costs a stuck row the sweep
 *    reclaims; a false "missing" costs a duplicate turn.
 */

export interface PromptLandingProofInput {
  /** The wire id the prompt was forwarded under. */
  messageId: string | undefined;
  /** Reads that one message from the runtime. `null`/`undefined` = the runtime
   *  answered and does not have it. Throwing = the runtime could not be asked.
   *  The SHAPE is deliberately opaque: existence is the whole question. */
  readMessage: (messageId: string) => Promise<unknown>;
  /** Total reads before giving up. */
  attempts?: number;
  /** Pause between reads. */
  delayMs?: number;
}

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_DELAY_MS = 700;

export async function confirmPromptLanded(input: PromptLandingProofInput): Promise<boolean> {
  const messageId = input.messageId?.trim();
  if (!messageId) return true;

  const attempts = input.attempts ?? DEFAULT_ATTEMPTS;
  const delayMs = input.delayMs ?? DEFAULT_DELAY_MS;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const message = await input.readMessage(messageId);
      if (message !== null && message !== undefined) return true;
    } catch {
      // Unreadable, not absent. See the header.
      return true;
    }
    if (attempt < attempts - 1 && delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return false;
}
