export function hasSessionRuntimeIdentity(input: {
  usesAcp: boolean;
  opencodeSessionId: string | null;
}): boolean {
  return input.usesAcp || Boolean(input.opencodeSessionId);
}

export function isSessionRuntimeActionReady(input: {
  switched: boolean;
  usesAcp: boolean;
  opencodeSessionId: string | null;
}): boolean {
  return input.switched && hasSessionRuntimeIdentity(input);
}
