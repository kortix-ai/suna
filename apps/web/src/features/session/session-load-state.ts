export function canMountSessionChat(input: {
  switched: boolean;
  opencodeSessionId: string | null;
}) {
  return input.switched || Boolean(input.opencodeSessionId);
}

export function findInitialSessionPin(
  sessions:
    | Array<{
        session_id: string;
        opencode_session_id: string | null;
      }>
    | undefined,
  sessionId: string,
) {
  return sessions?.find((session) => session.session_id === sessionId)?.opencode_session_id ?? null;
}

export function canShowSessionChat(input: {
  chatSessionId: string | null;
  runtimeError: unknown;
  runtimeBootError: unknown;
}) {
  return Boolean(input.chatSessionId || input.runtimeError || input.runtimeBootError);
}
