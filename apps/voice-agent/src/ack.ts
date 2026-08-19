/**
 * The "let me check" line, and why it is a fixed string rather than a prompt.
 *
 * When `send_prompt` hands work to Kortix, the room needs to hear something
 * immediately or the silence reads as the agent having died. That ack used to be
 * produced by RETURNING AN INSTRUCTION to the model ("Say one short sentence
 * that you are checking, then stop talking") — so the model composed it, and one
 * utterance ended up doing two jobs: acknowledging, and whatever else the model
 * felt like adding. On a real call it added a fabrication:
 *
 *   "Checking the main goals now. The project is about developing a system
 *    involving dogs, but I am gathering more details."
 *
 * Nothing had said anything about dogs — a stray transcription artifact seeded
 * it. But once spoken, that claim sat in the model's own conversation history as
 * established fact, so every correct answer Kortix sent back contradicted what
 * it believed, and it kept handing the contradiction BACK to Kortix to resolve.
 * Each of those is a real, paid Kortix turn. It ran until a human hung up.
 *
 * The cure is to take the sentence away from the model entirely. These strings
 * are spoken with `session.say()`, which is literal TTS with no LLM step (see
 * inbound-replies.ts's header for the say/generateReply distinction that this
 * codebase has already been burned by in the OTHER direction). A model cannot
 * append speculation to a sentence it never wrote.
 *
 * They ROTATE because the same sentence every single time sounds broken —
 * people notice a machine repeating itself far faster than they notice variety.
 * The rotation is a fixed cycle over a fixed list: deterministic, no LLM, no
 * randomness to reproduce when a transcript has to be explained later.
 *
 * Every line must therefore be true no matter what was asked, and must promise
 * NOTHING about the answer — the model does not know the answer yet, and neither
 * does this sentence.
 */
export const ACK_LINES = [
  'Let me check.',
  'One moment.',
  'Let me look that up.',
  'Give me a second.',
  'Checking on that now.',
] as const;

let ackIndex = 0;

/**
 * The next ack in the cycle. Module-level state is fine and deliberate: the
 * LiveKit worker forks a child process per job, so this counter is effectively
 * per-call, which is exactly the scope where "don't repeat yourself" matters.
 */
export function nextAckLine(): string {
  const line = ACK_LINES[ackIndex % ACK_LINES.length]!;
  ackIndex++;
  return line;
}

/** Test seam — resets the cycle so a test can assert the order from the top. */
export function resetAckRotation(): void {
  ackIndex = 0;
}
