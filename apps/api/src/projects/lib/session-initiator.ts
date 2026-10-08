// Session INITIATOR: who started a session's run, for attribution and the
// session list's mine / shared / automated split. It is not a permission: the
// policy class is `origin` (session-origin.ts), and the owner is `created_by`.
//
// A session spawned by another session belongs to its parent's run, so it
// copies the parent's initiator. A factory worker a trigger spawned is the
// trigger's, not the account owner's whose token the coordinator happened to
// carry. The backfill 20260929125453896_session_initiator_backfill mirrors
// `resolveRootSessionInitiator` in SQL; change both together.

export type SessionInitiatorType = 'member' | 'trigger' | 'channel' | 'api' | 'system';

export interface SessionInitiator {
  type: SessionInitiatorType;
  id: string | null;
}

export function resolveRootSessionInitiator(input: {
  /** `metadata.source`, server-set (never the request body). */
  source: string | null | undefined;
  triggerSlug: string | null | undefined;
  /** The create actor: the member, the service account, or a channel's owner stand-in. */
  userId: string | null;
  requestingPrincipalType: 'human' | 'service_account';
  /** Slack/Teams only: the deployment requires a linked Kortix identity, so the
   *  actor IS the human who sent the message (see on-behalf-of.ts). */
  channelSenderIsLinked: boolean;
}): SessionInitiator {
  const source = typeof input.source === 'string' ? input.source : '';
  if (source.startsWith('trigger:')) return { type: 'trigger', id: input.triggerSlug || null };
  if (source.startsWith('system:')) return { type: 'system', id: source };
  // Email and Telegram senders are never Kortix identities: the actor is the
  // account-owner stand-in, not the person who started the run.
  if (source === 'email' || source === 'telegram') return { type: 'channel', id: source };
  if ((source === 'slack' || source === 'teams') && !input.channelSenderIsLinked) {
    return { type: 'channel', id: source };
  }
  if (input.requestingPrincipalType === 'service_account') return { type: 'api', id: input.userId };
  return { type: 'member', id: input.userId };
}

export type SessionStartedByFilter = 'me' | 'others' | 'automated';

const CHANNEL_LABELS: Record<string, string> = {
  slack: 'Slack',
  teams: 'Teams',
  email: 'Email',
  telegram: 'Telegram',
};

/** The display name of a session's starter. `identityName` resolves a member
 *  or service-account id; triggers and channels name themselves. */
export function sessionInitiatorLabel(initiator: SessionInitiator, identityName: string | null): string | null {
  switch (initiator.type) {
    case 'member':
    case 'api':
      return identityName;
    case 'trigger':
      return initiator.id;
    case 'channel':
      return initiator.id ? (CHANNEL_LABELS[initiator.id] ?? initiator.id) : null;
    case 'system':
      return 'Kortix';
  }
}
