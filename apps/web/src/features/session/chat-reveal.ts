export function latchChatRevealed(
  alreadyShown: boolean,
  runtimeReady: boolean,
  hasSession: boolean,
): boolean {
  return alreadyShown || (runtimeReady && hasSession);
}

export function shouldRenderChat(revealed: boolean, hasSession: boolean): boolean {
  return revealed && hasSession;
}
