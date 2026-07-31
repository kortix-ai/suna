/**
 * Composer state while a session is still waking.
 *
 * The transcript now paints from the local cache before the sandbox is up (see
 * `session-transcript-cache` in the SDK), which is the point — reading back what
 * you already wrote should never wait on a VM. But the composer rides in on the
 * same shell, and `send()` only checks that an opencode session id exists, not
 * that its runtime answers. Rendering a live composer against a sleeping box
 * would take a prompt and drop it.
 *
 * So the transcript and the composer part ways here: history is readable
 * immediately, sending waits for the runtime, and the placeholder says which
 * state you're in rather than leaving a dead input to be discovered by typing
 * into it.
 */
export function sessionComposerReadiness(input: { runtimeReady: boolean }): {
  disabled: boolean;
  placeholder?: string;
} {
  if (input.runtimeReady) return { disabled: false };
  return { disabled: true, placeholder: 'Waking this session up…' };
}
