/**
 * A complete stand-in for `channels/core/identity` for `mock.module`.
 *
 * `mock.module` replaces a module wholesale, so a stub that lists only the
 * names one test needs deletes every other export, and the next importer
 * fails on a missing name. Start from this and override what the test drives.
 */
export function chatIdentityStub(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    chatUser: (platform: string, workspaceId: string, platformUserId: string) => ({
      platform,
      workspaceId,
      platformUserId,
    }),
    lookupChatIdentity: async () => null,
    linkChatIdentity: async () => {},
    revokeChatIdentity: async () => false,
    lookupChatUserForKortixUser: async () => null,
    isAccountMember: async () => false,
    resolveChatActor: async () => ({ reason: 'unlinked' }),
    resolveProjectChatActor: async () => ({ reason: 'unlinked' }),
    createChatAccessRequest: async () => ({ status: 'no-identity' }),
    ...overrides,
  };
}
