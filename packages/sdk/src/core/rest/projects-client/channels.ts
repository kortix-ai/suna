// Project channels — Slack + email inbound/outbound integration installs.

import { backendApi } from '../../http/api-client';
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

// ─── Telegram (optional channel — BYO bot from @BotFather) ──────────────────

/** A paired Telegram sender as shown in the dashboard: the numeric id plus any
 *  captured name/@username and, when photos were requested, an avatar data URI. */
export interface TelegramAllowedUser {
  id: string;
  firstName?: string;
  lastName?: string;
  username?: string;
  pairedAt?: string;
  /** Avatar `data:` URI when requested and available; null = none; absent =
   *  not requested (call getTelegramInstallation with `{ photos: true }`). */
  photo?: string | null;
}

export interface TelegramInstallation {
  botId: string;
  botUsername: string | null;
  installedAt: string;
  /** Telegram user ids allowed to drive the agent (the pairing allowlist). */
  allowedUserIds?: string[];
  /** The same allowlist enriched for display (name/@username/avatar). */
  allowedUsers?: TelegramAllowedUser[];
  /** Whether the server enforces the sender allowlist (TELEGRAM_REQUIRE_USER_IDENTITY). */
  pairingRequired?: boolean;
  /** Whether Telegram delivers group @mentions to this bot. `false` = BotFather
   *  privacy mode is ON (mentions never arrive — the bot only sees commands,
   *  replies and service messages in groups); `null`/absent = unknown. */
  groupMentionsEnabled?: boolean | null;
}

/** Single-use sender-pairing code — the user sends `/start <code>` to the bot. */
export interface TelegramPairing {
  code: string;
  expiresAt: string;
}

export async function getTelegramInstallation(
  projectId: string,
  opts: { photos?: boolean } = {},
): Promise<TelegramInstallation | null> {
  // `photos` inlines each paired user's avatar as a data URI — an extra
  // Telegram round-trip per user, so it's opt-in (the modal, not the base load).
  const qs = opts.photos ? '?photos=true' : '';
  const res = await backendApi.get<TelegramInstallation | null>(
    `/projects/${encodeURIComponent(projectId)}/channels/telegram/installation${qs}`,
    { showErrors: false },
  );
  if (!res.success) return null;
  return res.data ?? null;
}

export interface ConnectTelegramInput {
  bot_token: string;
}

export interface ConnectTelegramResult extends TelegramInstallation {
  /** First pairing code, minted with the install so the connect flow can walk
   *  the user straight onto the sender allowlist. */
  pairing?: TelegramPairing;
}

/** Validates the token with Telegram and registers the webhook server-side —
 *  the token never comes back in the response. */
export async function connectTelegram(
  projectId: string,
  input: ConnectTelegramInput,
): Promise<ConnectTelegramResult> {
  return unwrap(
    await backendApi.post<ConnectTelegramResult>(
      `/projects/${encodeURIComponent(projectId)}/channels/telegram/connect`,
      input,
      { showErrors: false },
    ),
    'Failed to connect',
  );
}

/** Mint a fresh single-use pairing code (replaces any outstanding one). */
export async function createTelegramPairingCode(projectId: string): Promise<TelegramPairing> {
  return unwrap(
    await backendApi.post<TelegramPairing>(
      `/projects/${encodeURIComponent(projectId)}/channels/telegram/pairing-code`,
      {},
      { showErrors: false },
    ),
    'Failed to create pairing code',
  );
}

/** Remove a paired Telegram sender from the project allowlist. */
export async function removeTelegramAllowedUser(
  projectId: string,
  userId: string,
): Promise<{ removed: boolean }> {
  return unwrap(
    await backendApi.delete<{ removed: boolean }>(
      `/projects/${encodeURIComponent(projectId)}/channels/telegram/allowed-users/${encodeURIComponent(userId)}`,
      { showErrors: false },
    ),
    'Failed to remove paired user',
  );
}

export async function disconnectTelegram(projectId: string): Promise<void> {
  await unwrap(
    await backendApi.delete<{ status: string }>(
      `/projects/${encodeURIComponent(projectId)}/channels/telegram/installation`,
      { showErrors: false },
    ),
    'Failed to disconnect',
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

/**
 * Download a Slack-hosted file through the server-side proxy (SSRF-guarded to
 * `*.slack.com`) — the bot token never reaches the sandbox. Backs `slack download`.
 */
export async function getSlackChannelFile(projectId: string, url: string): Promise<Blob> {
  return unwrap(
    await backendApi.get<Blob>(
      `/projects/${encodeURIComponent(projectId)}/channels/slack/file?url=${encodeURIComponent(url)}`,
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
  projectId: string,
  input: UploadSlackChannelFileInput,
): Promise<UploadSlackChannelFileResult> {
  return unwrap(
    await backendApi.post<UploadSlackChannelFileResult>(
      `/projects/${encodeURIComponent(projectId)}/channels/slack/file/upload`,
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
  allowedRegex: string | null;
}

export interface EmailInstallation {
  /** Canonical Kortix connection profile to pass in connector_bindings.email. */
  profileId: string | null;
  profileSlug: string;
  inboxId: string;
  email: string;
  displayName: string | null;
  webhookId: string | null;
  senderPolicy: EmailSenderPolicy;
  installedAt: string;
}

type EmailInstallationWire = Omit<EmailInstallation, 'profileId'> & {
  profile_id?: string | null;
  profileId?: string | null;
};

function normalizeEmailInstallation(value: EmailInstallationWire): EmailInstallation {
  return { ...value, profileId: value.profileId ?? value.profile_id ?? null };
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
  const res = await backendApi.get<EmailInstallationWire | null>(
    `/projects/${encodeURIComponent(projectId)}/channels/email/installation${query}`,
    { showErrors: false },
  );
  if (!res.success) return null;
  return res.data ? normalizeEmailInstallation(res.data) : null;
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
  const installation = unwrap(
    await backendApi.post<EmailInstallationWire>(
      `/projects/${encodeURIComponent(projectId)}/channels/email/connect`,
      input,
      { showErrors: false },
    ),
    'Failed to connect email',
  );
  return normalizeEmailInstallation(installation);
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
  const installation = unwrap(
    await backendApi.patch<EmailInstallationWire>(
      `/projects/${encodeURIComponent(projectId)}/channels/email/installation`,
      { connector_slug: connectorSlug ?? 'kortix_email', sender_policy: senderPolicy },
      { showErrors: false },
    ),
    'Failed to update email policy',
  );
  return normalizeEmailInstallation(installation);
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

export async function setMeetVoice(
  projectId: string,
  voice: string,
): Promise<{ selected: string }> {
  return unwrap(
    await backendApi.put<{ selected: string }>(
      `/projects/${encodeURIComponent(projectId)}/channels/meet/voice`,
      { voice },
      { showErrors: false },
    ),
    'Failed to save voice',
  );
}

export async function setMeetBotName(
  projectId: string,
  name: string,
): Promise<{ bot_name: string }> {
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
export async function previewMeetVoice(projectId: string, voiceId: string): Promise<string | null> {
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

/** Where an effective model came from — mirrors llm-gateway/resolution/effective.ts `ModelSource`. */
export type ChannelBindingModelSource = 'explicit' | 'agent' | 'project' | 'account' | 'platform';

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

export interface SpeakInMeetingResult {
  ok: boolean;
  voice: string;
}

/**
 * Make the meeting bot speak: text → ElevenLabs (project voice) → Recall
 * `output_audio`, both keys kept server-side. Backs `meet speak`.
 */
export async function speakInMeeting(
  projectId: string,
  botId: string,
  text: string,
  voice?: string,
): Promise<SpeakInMeetingResult> {
  return unwrap(
    await backendApi.post<SpeakInMeetingResult>(
      `/projects/${encodeURIComponent(projectId)}/channels/meet/speak`,
      { bot_id: botId, text, voice },
      { showErrors: false },
    ),
    'Failed to speak in meeting',
  );
}
