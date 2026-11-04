/**
 * Reconstruct channel runtime env from the durable session metadata.
 *
 * Create-time extraEnvVars are not persisted as a standalone record. A cold
 * reprovision must therefore derive the channel contract from metadata.
 */
export function sessionChannelEnvFromMetadata(metadata: unknown): Record<string, string> {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {};
  const channels = metadata as {
    slack?: Record<string, unknown>;
    email?: Record<string, unknown>;
  };
  const env: Record<string, string> = {};

  const slack = channels.slack;
  if (slack && typeof slack === 'object' && !Array.isArray(slack)) {
    if (typeof slack.team_id === 'string') env.SLACK_TEAM_ID = slack.team_id;
    if (typeof slack.channel === 'string') env.SLACK_CHANNEL_ID = slack.channel;
    if (typeof slack.thread_ts === 'string') env.SLACK_THREAD_TS = slack.thread_ts;
    if (typeof slack.user === 'string') env.SLACK_USER_ID = slack.user;
  }

  const email = channels.email;
  if (email && typeof email === 'object' && !Array.isArray(email)) {
    if (typeof email.inbox_id === 'string') env.KORTIX_EMAIL_INBOX_ID = email.inbox_id;
    if (typeof email.thread_id === 'string') env.KORTIX_EMAIL_THREAD_ID = email.thread_id;
    if (typeof email.message_id === 'string') env.KORTIX_EMAIL_MESSAGE_ID = email.message_id;
    if (typeof email.address === 'string') env.KORTIX_EMAIL_ADDRESS = email.address;
  }

  return env;
}

/**
 * The channel or DM a thread belongs to (`project_channels`), for the agent:
 * `KORTIX_SPACE_SLUG` is the channel's slug, or the agent's name in a DM.
 * Its folders are named in /drives/README.md.
 */
export function sessionSpaceEnv(
  space: { spaceId: string; kind: 'channel' | 'dm'; slug: string | null; dmAgentName: string | null } | null,
): Record<string, string> {
  const name = space?.kind === 'channel' ? space.slug : space?.dmAgentName;
  if (!space || !name) return {};
  return { KORTIX_SPACE_ID: space.spaceId, KORTIX_SPACE_KIND: space.kind, KORTIX_SPACE_SLUG: name };
}
