export interface SessionChatMountInput {
  switched: boolean;
  fresh: boolean;
  shellSubmitted: boolean;
  chatReady: boolean;
}

/**
 * Decide whether the ACP chat subtree must stay mounted.
 *
 * Before first readiness, the runtime switch and fresh-session submit gates
 * still control the mount. After `AcpSessionChat` has reported ready,
 * `chatReady` is sticky for this route session: a recovery may temporarily
 * make `switched` false, but unmounting the chat then would leave the already
 * dismissed boot layer with nothing to render.
 */
export function shouldMountAcpChat(input: SessionChatMountInput): boolean {
  return input.chatReady || (input.switched && (!input.fresh || input.shellSubmitted));
}
