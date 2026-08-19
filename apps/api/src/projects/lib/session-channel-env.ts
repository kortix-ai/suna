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
    // The metadata itself is the durable email-origin marker. This also
    // upgrades sessions created before the explicit MCP flag existed.
    env.KORTIX_CONNECTORS_MCP_ENABLED = '1';
    if (typeof email.inbox_id === 'string') env.KORTIX_EMAIL_INBOX_ID = email.inbox_id;
    if (typeof email.thread_id === 'string') env.KORTIX_EMAIL_THREAD_ID = email.thread_id;
    if (typeof email.message_id === 'string') env.KORTIX_EMAIL_MESSAGE_ID = email.message_id;
    if (typeof email.address === 'string') env.KORTIX_EMAIL_ADDRESS = email.address;
  }

  return env;
}
