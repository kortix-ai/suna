// Workspace channels — Slack + email inbound/outbound connection installs.

import { backendApi } from '../../http/api-client';
import { unwrap } from './shared';

export interface ChatIdentityBindResult {
  ok: boolean;
  workspaceName: string | null;
  hasAccess: boolean;
  resumed: boolean;
}

async function bindChatIdentity(
  service: 'slack' | 'teams',
  token: string,
): Promise<ChatIdentityBindResult> {
  return unwrap(
    await backendApi.post<ChatIdentityBindResult>(`/channels/${service}/identity/bind`, { token }),
    'Failed to connect your account',
  );
}

export function bindSlackIdentity(token: string): Promise<ChatIdentityBindResult> {
  return bindChatIdentity('slack', token);
}

export function bindTeamsIdentity(token: string): Promise<ChatIdentityBindResult> {
  return bindChatIdentity('teams', token);
}

export interface SlackInstallation {
  workspaceId: string;
  workspaceName: string | null;
  botUserId: string | null;
  installedAt: string;
}

export async function getSlackInstallation(workspaceId: string): Promise<SlackInstallation | null> {
  const res = await backendApi.get<SlackInstallation | null>(
    `/workspaces/${encodeURIComponent(workspaceId)}/channels/slack/installation`,
    { showErrors: false },
  );
  if (!res.success) return null;
  return res.data ?? null;
}

export interface ConnectSlackInput {
  bot_token: string;
  signing_secret: string;
}

export async function connectSlack(
  workspaceId: string,
  input: ConnectSlackInput,
): Promise<SlackInstallation> {
  return unwrap(
    await backendApi.post<SlackInstallation>(
      `/workspaces/${encodeURIComponent(workspaceId)}/channels/slack/connect`,
      input,
      { showErrors: false },
    ),
    'Failed to connect',
  );
}

export interface SlackMode {
  oauth_available: boolean;
  install_url: string | null;
}

const DEFAULT_SLACK_MODE: SlackMode = { oauth_available: false, install_url: null };

export async function getSlackMode(workspaceId: string): Promise<SlackMode> {
  const res = await backendApi.get<SlackMode>(
    `/workspaces/${encodeURIComponent(workspaceId)}/channels/slack/mode`,
    { showErrors: false },
  );
  if (!res.success || !res.data) return DEFAULT_SLACK_MODE;
  return res.data;
}

export async function getSlackManifest(workspaceId: string): Promise<Record<string, unknown>> {
  return unwrap(
    await backendApi.get<Record<string, unknown>>(
      `/webhooks/slack/${encodeURIComponent(workspaceId)}/manifest`,
      { showErrors: false },
    ),
    'Failed to load Slack manifest',
  );
}

export async function disconnectSlack(workspaceId: string): Promise<void> {
  const res = await backendApi.delete(
    `/workspaces/${encodeURIComponent(workspaceId)}/channels/slack/installation`,
    { showErrors: false },
  );
  if (!res.success) throw new Error(res.error?.message ?? 'Failed to disconnect');
}

/**
 * Download a Slack-hosted file through the server-side proxy (SSRF-guarded to
 * `*.slack.com`) — the bot token never reaches the sandbox. Backs `slack download`.
 */
export async function getSlackChannelFile(workspaceId: string, url: string): Promise<Blob> {
  return unwrap(
    await backendApi.get<Blob>(
      `/workspaces/${encodeURIComponent(workspaceId)}/channels/slack/file?url=${encodeURIComponent(url)}`,
      { showErrors: false },
    ),
    'Failed to download Slack file',
  );
}

export interface UploadSlackChannelFileInput {
  channel: string;
  filename: string;
  /** Base64-encoded file content. */
  contentBase64: string;
  comment?: string;
  threadTs?: string;
}

export interface UploadSlackChannelFileResult {
  ok: boolean;
  files: unknown;
}

/** Upload a file to Slack through the server-side 3-step external-upload proxy. Backs `slack send --file`. */
export async function uploadSlackChannelFile(
  workspaceId: string,
  input: UploadSlackChannelFileInput,
): Promise<UploadSlackChannelFileResult> {
  return unwrap(
    await backendApi.post<UploadSlackChannelFileResult>(
      `/workspaces/${encodeURIComponent(workspaceId)}/channels/slack/file/upload`,
      {
        channel: input.channel,
        filename: input.filename,
        content_base64: input.contentBase64,
        comment: input.comment,
        thread_ts: input.threadTs,
      },
      { showErrors: false },
    ),
    'Failed to upload Slack file',
  );
}

export interface EmailSenderPolicy {
  mode: 'allow_all' | 'restricted';
  allowedEmails: string[];
  allowedDomains: string[];
  /**
   * Case-insensitive, unanchored RE2-compatible pattern (maximum 256
   * characters). Backreferences and look-around are intentionally unsupported.
   */
  allowedRegex: string | null;
}

export interface EmailInstallation {
  /** Kortix connection to pass in connector_bindings.email. */
  connectionId: string | null;
  connectorSlug: string;
  inboxId: string;
  email: string;
  displayName: string | null;
  webhookId: string | null;
  senderPolicy: EmailSenderPolicy;
  installedAt: string;
}

export type EmailConnectionInstallation = EmailInstallation;

type EmailInstallationWire = Omit<
  EmailInstallation,
  'connectionId' | 'connectorSlug'
> & {
  connection_id?: string | null;
  connectionId?: string | null;
  connector_slug?: string | null;
  connectorSlug?: string | null;
  connection_slug?: string | null;
  connectionSlug?: string | null;
};

function normalizeEmailInstallation(value: EmailInstallationWire): EmailConnectionInstallation {
  const connectionId = value.connectionId ?? value.connection_id ?? null;
  const connectorSlug =
    value.connectorSlug ??
    value.connector_slug ??
    value.connectionSlug ??
    value.connection_slug ??
    'kortix_email';
  return {
    ...value,
    connectionId,
    connectorSlug,
  };
}

export interface EmailMode {
  provider: 'agentmail';
  enabled?: boolean;
  managed_available: boolean;
}

const DEFAULT_EMAIL_MODE: EmailMode = { provider: 'agentmail', managed_available: false };

export async function getEmailInstallation(
  workspaceId: string,
  connectorSlug?: string | null,
): Promise<EmailConnectionInstallation | null> {
  const query = connectorSlug ? `?connector_slug=${encodeURIComponent(connectorSlug)}` : '';
  const res = await backendApi.get<EmailInstallationWire | null>(
    `/workspaces/${encodeURIComponent(workspaceId)}/channels/email/installation${query}`,
    { showErrors: false },
  );
  if (!res.success) return null;
  return res.data ? normalizeEmailInstallation(res.data) : null;
}

export async function getEmailMode(workspaceId: string): Promise<EmailMode> {
  const res = await backendApi.get<EmailMode>(
    `/workspaces/${encodeURIComponent(workspaceId)}/channels/email/mode`,
    { showErrors: false },
  );
  if (!res.success || !res.data) return DEFAULT_EMAIL_MODE;
  return res.data;
}

export interface ConnectEmailInput {
  connector_slug?: string;
  api_key?: string;
  display_name?: string;
  username?: string;
  domain?: string;
  inbox_id?: string;
  email?: string;
  sender_policy?: EmailSenderPolicy;
}

export async function connectEmail(
  workspaceId: string,
  input: ConnectEmailInput,
): Promise<EmailConnectionInstallation> {
  const installation = unwrap(
    await backendApi.post<EmailInstallationWire>(
      `/workspaces/${encodeURIComponent(workspaceId)}/channels/email/connect`,
      input,
      { showErrors: false },
    ),
    'Failed to connect email',
  );
  return normalizeEmailInstallation(installation);
}

export async function disconnectEmail(
  workspaceId: string,
  connectorSlug?: string | null,
): Promise<void> {
  const query = connectorSlug ? `?connector_slug=${encodeURIComponent(connectorSlug)}` : '';
  const res = await backendApi.delete(
    `/workspaces/${encodeURIComponent(workspaceId)}/channels/email/installation${query}`,
    { showErrors: false },
  );
  if (!res.success) throw new Error(res.error?.message ?? 'Failed to disconnect email');
}

export async function updateEmailPolicy(
  workspaceId: string,
  connectorSlug: string | null | undefined,
  senderPolicy: EmailSenderPolicy,
): Promise<EmailConnectionInstallation> {
  const installation = unwrap(
    await backendApi.patch<EmailInstallationWire>(
      `/workspaces/${encodeURIComponent(workspaceId)}/channels/email/installation`,
      { connector_slug: connectorSlug ?? 'kortix_email', sender_policy: senderPolicy },
      { showErrors: false },
    ),
    'Failed to update email policy',
  );
  return normalizeEmailInstallation(installation);
}

// ── Voice — the display name the bot uses when it joins a call ──
// The voice itself now comes from the realtime provider, not a per-workspace
// ElevenLabs pick, so the name is all that's left to configure here.

export async function setMeetBotName(
  workspaceId: string,
  name: string,
): Promise<{ bot_name: string }> {
  return unwrap(
    await backendApi.put<{ bot_name: string }>(
      `/workspaces/${encodeURIComponent(workspaceId)}/channels/meet/name`,
      { name },
      { showErrors: false },
    ),
    'Failed to save name',
  );
}

// ── Channel bindings — which agent/model/join-policy a bound chat channel uses ──
// The web management surface for `chat_channel_bindings`. Today the only other
// way to change these is the in-Slack `/kortix agent|model|policy` commands —
// this is the same underlying row, just editable from the dashboard.

export type ChannelConversationPolicy = 'owner_approval' | 'owner_only' | 'workspace_open';

export interface ChannelBindingEffectiveAgent {
  agent: string;
  source: 'explicit' | 'workspace' | 'fallback';
}

/** Where an effective model came from — mirrors llm-gateway/resolution/effective.ts `ModelSource`. */
export type ChannelBindingModelSource = 'explicit' | 'agent' | 'workspace' | 'account' | 'platform';

export interface ChannelBindingEffectiveModel {
  /** A concrete gateway wire model id, or null when only the platform default applies (renders as "auto"). */
  model: string | null;
  source: ChannelBindingModelSource;
}

export interface ChannelBinding {
  bindingId: string;
  platform: string;
  workspaceId: string;
  channelId: string;
  channelName: string | null;
  channelType: string | null;
  agentName: string | null;
  opencodeModel: string | null;
  conversationPolicy: ChannelConversationPolicy;
  installedAt: string;
  effectiveAgent: ChannelBindingEffectiveAgent;
  effectiveModel: ChannelBindingEffectiveModel;
}

export interface ChannelBindingsResponse {
  workspaceDefaultAgent: string | null;
  bindings: ChannelBinding[];
}

export async function listChannelBindings(workspaceId: string): Promise<ChannelBindingsResponse> {
  return unwrap(
    await backendApi.get<ChannelBindingsResponse>(
      `/workspaces/${encodeURIComponent(workspaceId)}/channels/bindings`,
      { showErrors: false },
    ),
    'Failed to load channel bindings',
  );
}

export interface UpdateChannelBindingInput {
  /** null resets the agent override to the workspace default. */
  agentName?: string | null;
  /** null resets the model override to the workspace/account/platform default. */
  opencodeModel?: string | null;
  conversationPolicy?: ChannelConversationPolicy;
}

export async function updateChannelBinding(
  workspaceId: string,
  bindingId: string,
  input: UpdateChannelBindingInput,
): Promise<ChannelBinding> {
  return unwrap(
    await backendApi.patch<ChannelBinding>(
      `/workspaces/${encodeURIComponent(workspaceId)}/channels/bindings/${encodeURIComponent(bindingId)}`,
      input,
      { showErrors: false },
    ),
    'Failed to update channel binding',
  );
}
