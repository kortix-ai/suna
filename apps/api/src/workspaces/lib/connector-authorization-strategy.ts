export type ConnectorAuthorizationStrategy = 'project' | 'user';

export type ConnectionOwnerType =
  | 'project'
  | 'agent'
  | 'member'
  | 'subject'
  | 'external';

export function connectorAuthorizationMatchesStrategy(input: {
  strategy: ConnectorAuthorizationStrategy;
  ownerType: ConnectionOwnerType;
  ownerId: string | null;
  actingUserId: string;
  actingPrincipalIsServiceAccount: boolean;
  trustedManagedSystem?: boolean;
}): boolean {
  if (input.strategy === 'project') {
    return input.ownerType === 'project' || input.trustedManagedSystem === true;
  }
  return (
    !input.actingPrincipalIsServiceAccount &&
    input.ownerType === 'member' &&
    input.ownerId === input.actingUserId
  );
}

export function isTrustedManagedChannelAuthorization(input: {
  providerType: string;
  platform: string | null;
  ownerType: ConnectionOwnerType;
  ownerId: string | null;
  metadata: Record<string, unknown>;
}): boolean {
  const inboxId = input.metadata.inbox_id;
  return (
    input.providerType === 'channel' &&
    input.platform === 'email' &&
    input.ownerType === 'external' &&
    input.metadata.channel_connection === true &&
    typeof inboxId === 'string' &&
    inboxId.length > 0 &&
    input.ownerId === `agentmail:${inboxId}`
  );
}
