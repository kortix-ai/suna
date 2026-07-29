export function hasSessionRuntimeIdentity(input: {
  usesAcp: boolean;
  opencodeSessionId: string | null;
}): boolean {
  return input.usesAcp || Boolean(input.opencodeSessionId);
}
