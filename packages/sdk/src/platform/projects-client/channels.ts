// Project channels — Slack + email inbound/outbound integration installs.

import { backendApi } from '../api-client';
import { unwrap } from './shared';

export interface SlackInstallation {
  workspaceId: string;
  workspaceName: string | null;
  botUserId: string | null;
  installedAt: string;
}

export async function getSlackInstallation(projectId: string): Promise<SlackInstallation | null> {
  const res = await backendApi.get<SlackInstallation | null>(
    `/projects/${encodeURIComponent(projectId)}/channels/slack/installation`,
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
  projectId: string,
  input: ConnectSlackInput,
): Promise<SlackInstallation> {
  return unwrap(
    await backendApi.post<SlackInstallation>(
      `/projects/${encodeURIComponent(projectId)}/channels/slack/connect`,
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

export async function getSlackMode(projectId: string): Promise<SlackMode> {
  const res = await backendApi.get<SlackMode>(
    `/projects/${encodeURIComponent(projectId)}/channels/slack/mode`,
    { showErrors: false },
  );
  if (!res.success || !res.data) return DEFAULT_SLACK_MODE;
  return res.data;
}

export async function getSlackManifest(projectId: string): Promise<Record<string, unknown>> {
  return unwrap(
    await backendApi.get<Record<string, unknown>>(
      `/webhooks/slack/${encodeURIComponent(projectId)}/manifest`,
      { showErrors: false },
    ),
    'Failed to load Slack manifest',
  );
}

export async function disconnectSlack(projectId: string): Promise<void> {
  const res = await backendApi.delete(
    `/projects/${encodeURIComponent(projectId)}/channels/slack/installation`,
    { showErrors: false },
  );
  if (!res.success) throw new Error(res.error?.message ?? 'Failed to disconnect');
}

export interface EmailSenderPolicy {
  mode: 'allow_all' | 'restricted';
  allowedEmails: string[];
  allowedDomains: string[];
  allowedRegex: string | null;
}

export interface EmailInstallation {
  profileSlug: string;
  inboxId: string;
  email: string;
  displayName: string | null;
  webhookId: string | null;
  senderPolicy: EmailSenderPolicy;
  installedAt: string;
}

export interface EmailMode {
  provider: 'agentmail';
  enabled?: boolean;
  managed_available: boolean;
}

const DEFAULT_EMAIL_MODE: EmailMode = { provider: 'agentmail', managed_available: false };

export async function getEmailInstallation(
  projectId: string,
  connectorSlug?: string | null,
): Promise<EmailInstallation | null> {
  const query = connectorSlug ? `?connector_slug=${encodeURIComponent(connectorSlug)}` : '';
  const res = await backendApi.get<EmailInstallation | null>(
    `/projects/${encodeURIComponent(projectId)}/channels/email/installation${query}`,
    { showErrors: false },
  );
  if (!res.success) return null;
  return res.data ?? null;
}

export async function getEmailMode(projectId: string): Promise<EmailMode> {
  const res = await backendApi.get<EmailMode>(
    `/projects/${encodeURIComponent(projectId)}/channels/email/mode`,
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
  projectId: string,
  input: ConnectEmailInput,
): Promise<EmailInstallation> {
  return unwrap(
    await backendApi.post<EmailInstallation>(
      `/projects/${encodeURIComponent(projectId)}/channels/email/connect`,
      input,
      { showErrors: false },
    ),
    'Failed to connect email',
  );
}

export async function disconnectEmail(
  projectId: string,
  connectorSlug?: string | null,
): Promise<void> {
  const query = connectorSlug ? `?connector_slug=${encodeURIComponent(connectorSlug)}` : '';
  const res = await backendApi.delete(
    `/projects/${encodeURIComponent(projectId)}/channels/email/installation${query}`,
    { showErrors: false },
  );
  if (!res.success) throw new Error(res.error?.message ?? 'Failed to disconnect email');
}

export async function updateEmailPolicy(
  projectId: string,
  connectorSlug: string | null | undefined,
  senderPolicy: EmailSenderPolicy,
): Promise<EmailInstallation> {
  return unwrap(
    await backendApi.patch<EmailInstallation>(
      `/projects/${encodeURIComponent(projectId)}/channels/email/installation`,
      { connector_slug: connectorSlug ?? 'kortix_email', sender_policy: senderPolicy },
      { showErrors: false },
    ),
    'Failed to update email policy',
  );
}

// ── Meet — the bot voice + display name a project's Google/Zoom Meet channel uses ──

export interface MeetVoice {
  id: string;
  name: string;
  desc: string;
}

export interface MeetVoicesResponse {
  selected: string;
  bot_name: string;
  default_bot_name: string;
  speak_enabled: boolean;
  voices: MeetVoice[];
}

export async function getMeetVoices(projectId: string): Promise<MeetVoicesResponse | null> {
  const res = await backendApi.get<MeetVoicesResponse>(
    `/projects/${encodeURIComponent(projectId)}/channels/meet/voices`,
    { showErrors: false },
  );
  if (!res.success) return null;
  return res.data ?? null;
}

export async function setMeetVoice(projectId: string, voice: string): Promise<{ selected: string }> {
  return unwrap(
    await backendApi.put<{ selected: string }>(
      `/projects/${encodeURIComponent(projectId)}/channels/meet/voice`,
      { voice },
      { showErrors: false },
    ),
    'Failed to save voice',
  );
}

export async function setMeetBotName(projectId: string, name: string): Promise<{ bot_name: string }> {
  return unwrap(
    await backendApi.put<{ bot_name: string }>(
      `/projects/${encodeURIComponent(projectId)}/channels/meet/name`,
      { name },
      { showErrors: false },
    ),
    'Failed to save name',
  );
}

/** Returns a base64-encoded audio sample for the given voice, or null on failure. */
export async function previewMeetVoice(
  projectId: string,
  voiceId: string,
): Promise<string | null> {
  const res = await backendApi.post<{ b64: string }>(
    `/projects/${encodeURIComponent(projectId)}/channels/meet/voices/${encodeURIComponent(voiceId)}/preview`,
    {},
    { showErrors: false },
  );
  if (!res.success || !res.data?.b64) return null;
  return res.data.b64;
}

// ── Channel bindings — which agent/model/join-policy a bound chat channel uses ──
// The web management surface for `chat_channel_bindings`. Today the only other
// way to change these is the in-Slack `/kortix agent|model|policy` commands —
// this is the same underlying row, just editable from the dashboard.

export type ChannelConversationPolicy = 'owner_approval' | 'owner_only' | 'project_open';

export interface ChannelBindingEffectiveAgent {
  agent: string;
  source: 'explicit' | 'project' | 'fallback';
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
}

export interface ChannelBindingsResponse {
  projectDefaultAgent: string | null;
  bindings: ChannelBinding[];
}

export async function listChannelBindings(projectId: string): Promise<ChannelBindingsResponse> {
  return unwrap(
    await backendApi.get<ChannelBindingsResponse>(
      `/projects/${encodeURIComponent(projectId)}/channels/bindings`,
      { showErrors: false },
    ),
    'Failed to load channel bindings',
  );
}

export interface UpdateChannelBindingInput {
  /** null resets the agent override to the project default. */
  agentName?: string | null;
  /** null resets the model override to the project/account/platform default. */
  opencodeModel?: string | null;
  conversationPolicy?: ChannelConversationPolicy;
}

export async function updateChannelBinding(
  projectId: string,
  bindingId: string,
  input: UpdateChannelBindingInput,
): Promise<ChannelBinding> {
  return unwrap(
    await backendApi.patch<ChannelBinding>(
      `/projects/${encodeURIComponent(projectId)}/channels/bindings/${encodeURIComponent(bindingId)}`,
      input,
      { showErrors: false },
    ),
    'Failed to update channel binding',
  );
}
