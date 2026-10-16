export type InlinePermissionReply = 'once' | 'always' | 'reject';

/**
 * Send an inline permission reply without ever rejecting. The runtime refuses a
 * reply for a request that no longer exists (already answered elsewhere, or
 * expired): that refusal goes to `onFailure` and resolves `false`, so the
 * card can re-enable instead of leaking an unhandled rejection.
 */
export async function replyToInlinePermission(
  onReply: ((requestId: string, reply: InlinePermissionReply) => Promise<void> | void) | undefined,
  requestId: string,
  reply: InlinePermissionReply,
  onFailure: (error: unknown) => void,
): Promise<boolean> {
  if (!onReply) return false;
  try {
    await onReply(requestId, reply);
    return true;
  } catch (error) {
    onFailure(error);
    return false;
  }
}
