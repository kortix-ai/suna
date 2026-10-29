// Project channels — Slack, Teams, email and Telegram connection installs.

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

/** Which chat account a Slack or Teams login link would link. Read-only. */
export interface ChatIdentityPreview {
  service: 'slack' | 'teams';
  /** The Slack workspace or Teams team name, when known. */
  workspaceName: string | null;
  /** The Slack or Teams user id carried by the link. */
  chatUserId: string;
  /** That user's display name, when the platform returns one. */
  chatUserName: string | null;
}

async function previewChatIdentity(
  service: 'slack' | 'teams',
  token: string,
): Promise<ChatIdentityPreview> {
  return unwrap(
    await backendApi.post<ChatIdentityPreview>(
      `/channels/${service}/identity/preview`,
      { token },
      { showErrors: false },
    ),
    'This link is invalid or has expired',
  );
}

/** The Slack account a `/kortix login` link would link, before binding it. */
export function previewSlackIdentity(token: string): Promise<ChatIdentityPreview> {
  return previewChatIdentity('slack', token);
}

/** The Teams account a login link would link, before binding it. */
export function previewTeamsIdentity(token: string): Promise<ChatIdentityPreview> {
  return previewChatIdentity('teams', token);
}

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

/** The provider's OAuth `code` and the signed `state` from the install redirect. */
export interface ChannelInstallCompletionInput {
  code: string;
  state: string;
}

export interface ChannelInstallCompletion {
  /** The dashboard page the install outcome lands on. */
  redirect_url: string;
}

async function completeChannelInstall(
  service: 'slack' | 'teams',
  projectId: string,
  input: ChannelInstallCompletionInput,
): Promise<ChannelInstallCompletion> {
  return unwrap(
    await backendApi.post<ChannelInstallCompletion>(
      `/projects/${encodeURIComponent(projectId)}/channels/${service}/oauth/complete`,
      { code: input.code, state: input.state },
      { showErrors: false },
    ),
    'Failed to finish the install',
  );
}

/**
 * Finish a Slack "Add to Slack" install as the signed-in user. The API installs
 * only when the signed state names this user and project; otherwise it rejects
 * with `403` and code `CHANNEL_INSTALL_STATE_MISMATCH` (`400`
 * `CHANNEL_INSTALL_STATE_INVALID` for an expired or malformed state).
 */
export function completeSlackInstall(
  projectId: string,
  input: ChannelInstallCompletionInput,
): Promise<ChannelInstallCompletion> {
  return completeChannelInstall('slack', projectId, input);
}

/** Finish a Microsoft Teams org install as the signed-in user. Same contract as `completeSlackInstall`. */
export function completeTeamsInstall(
  projectId: string,
  input: ChannelInstallCompletionInput,
): Promise<ChannelInstallCompletion> {
  return completeChannelInstall('teams', projectId, input);
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

/** A project's Telegram bot. */
export interface TelegramInstallation {
  bot_id: string;
  username: string | null;
  /** Telegram user ids allowed to talk to the bot; anyone else gets a pairing reply. */
  allowed_user_ids: string[];
  /** How many people messaged the bot privately and are not allowed yet. Absent on older servers. */
  access_request_count?: number;
}

/** A Telegram user, as the bot knows them. */
export interface TelegramUser {
  user_id: string;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
  /** Changes when the profile photo changes; null when the user has no visible photo. Pass it to `getTelegramUserPhoto`. */
  photo_version: string | null;
  /** False when Telegram returned no profile and the bot has never seen the user: only `user_id` is real. */
  known: boolean;
}

/** A person who messaged the bot privately but is not allowed yet. */
export interface TelegramAccessRequest extends TelegramUser {
  /** ISO time of their latest message. */
  last_seen: string;
}

export interface TelegramUsers {
  /** In allowed-list order. */
  allowed: TelegramUser[];
  /** Newest first. Excludes allowed users and requests older than 30 days. */
  requests: TelegramAccessRequest[];
}

/** A chat platform whose bot keeps an allowed-user list and access requests. */
export type ChannelAccessPlatform = 'telegram';

/** A chat user, as the platform's bot knows them. */
export interface ChannelUser {
  user_id: string;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
  /** Changes when the profile photo changes; null when the user has no visible photo. Pass it to `getChannelUserPhoto`. */
  photo_version: string | null;
  /** False when the platform returned no profile and the bot has never seen the user: only `user_id` is real. */
  known: boolean;
}

/** A person who messaged the bot privately but is not allowed yet. */
export interface ChannelAccessRequest extends ChannelUser {
  /** ISO time of their latest message. */
  last_seen: string;
}

export interface ChannelUsers {
  /** In allowed-list order. */
  allowed: ChannelUser[];
  /** Newest first. Excludes allowed users and requests older than 30 days. */
  requests: ChannelAccessRequest[];
}

/** The access fields of the installation that every allowed-user and access-request edit returns. */
export interface ChannelAccessList {
  /** The allowed user ids. Telegram returns them; another platform may not. */
  allowed_user_ids?: string[];
  /** How many people messaged the bot privately and are not allowed yet. */
  access_request_count?: number;
}

const channelPath = (projectId: string, platform: ChannelAccessPlatform) =>
  `/projects/${encodeURIComponent(projectId)}/channels/${platform}`;
// A literal path, so route-contract.test.ts resolves the Telegram-only routes
// to `/channels/telegram/…` and fails when the API drops one.
const telegramPath = (projectId: string) => `/projects/${encodeURIComponent(projectId)}/channels/telegram`;

async function channelUsers(
  projectId: string,
  platform: ChannelAccessPlatform,
  fallback: string,
): Promise<ChannelUsers> {
  return unwrap(
    await backendApi.get<ChannelUsers>(`${channelPath(projectId, platform)}/users`, { showErrors: false }),
    fallback,
  );
}

async function allowUser<T>(
  projectId: string,
  platform: ChannelAccessPlatform,
  userId: string,
  fallback: string,
): Promise<T> {
  return unwrap(
    await backendApi.post<T>(
      `${channelPath(projectId, platform)}/allowed-users`,
      { user_id: userId },
      { showErrors: false },
    ),
    fallback,
  );
}

async function removeUser<T>(
  projectId: string,
  platform: ChannelAccessPlatform,
  userId: string,
  fallback: string,
): Promise<T> {
  return unwrap(
    await backendApi.delete<T>(
      `${channelPath(projectId, platform)}/allowed-users/${encodeURIComponent(userId)}`,
      { showErrors: false },
    ),
    fallback,
  );
}

async function dismissRequest<T>(
  projectId: string,
  platform: ChannelAccessPlatform,
  userId: string,
  fallback: string,
): Promise<T> {
  return unwrap(
    await backendApi.delete<T>(
      `${channelPath(projectId, platform)}/access-requests/${encodeURIComponent(userId)}`,
      { showErrors: false },
    ),
    fallback,
  );
}

async function userPhoto(
  projectId: string,
  platform: ChannelAccessPlatform,
  userId: string,
  version: string | null | undefined,
  signal: AbortSignal | undefined,
  fallback: string,
): Promise<Blob | null> {
  const query = version ? `?v=${encodeURIComponent(version)}` : '';
  const res = await backendApi.get<Blob>(
    `${channelPath(projectId, platform)}/users/${encodeURIComponent(userId)}/photo${query}`,
    { showErrors: false, signal },
  );
  if (res.error?.status === 404) return null;
  return unwrap(res, fallback);
}

/** The project's Telegram bot, or null when none is connected (or the flag is off). */
export async function getTelegramInstallation(projectId: string): Promise<TelegramInstallation | null> {
  const res = await backendApi.get<TelegramInstallation | null>(
    `${telegramPath(projectId)}/installation`,
    { showErrors: false },
  );
  if (!res.success) return null;
  return res.data ?? null;
}

export interface ConnectTelegramInput {
  /** The token BotFather gave you: `<bot id>:<secret>`. */
  bot_token: string;
  allowed_user_ids?: string[];
}

/** Connect a Telegram bot: Kortix registers its webhook and stores the token server-side. */
export async function connectTelegram(
  projectId: string,
  input: ConnectTelegramInput,
): Promise<TelegramInstallation> {
  return unwrap(
    await backendApi.post<TelegramInstallation>(
      `${telegramPath(projectId)}/connect`,
      input,
      { showErrors: false },
    ),
    'Failed to connect Telegram',
  );
}

/** Replace the Telegram user ids allowed to talk to the bot. */
export async function setTelegramAllowedUsers(
  projectId: string,
  userIds: string[],
): Promise<TelegramInstallation> {
  return unwrap(
    await backendApi.put<TelegramInstallation>(
      `${telegramPath(projectId)}/allowed-users`,
      { user_ids: userIds },
      { showErrors: false },
    ),
    'Failed to update allowed Telegram users',
  );
}

export async function disconnectTelegram(projectId: string): Promise<void> {
  const res = await backendApi.delete(telegramPath(projectId), { showErrors: false });
  if (!res.success) throw new Error(res.error?.message ?? 'Failed to disconnect Telegram');
}

/** The allowed users and the people who asked for access, with their Telegram names. */
export function listTelegramUsers(projectId: string): Promise<TelegramUsers> {
  return channelUsers(projectId, 'telegram', 'Failed to load Telegram users');
}

/** Allow one Telegram user. Adds the id once and clears their access request. */
export function allowTelegramUser(projectId: string, userId: string): Promise<TelegramInstallation> {
  return allowUser(projectId, 'telegram', userId, 'Failed to allow the Telegram user');
}

/** Remove one Telegram user from the allowed list. Idempotent. */
export function removeTelegramUser(projectId: string, userId: string): Promise<TelegramInstallation> {
  return removeUser(projectId, 'telegram', userId, 'Failed to remove the Telegram user');
}

/** Dismiss one access request without allowing the user. Idempotent. */
export function dismissTelegramAccessRequest(
  projectId: string,
  userId: string,
): Promise<TelegramInstallation> {
  return dismissRequest(projectId, 'telegram', userId, 'Failed to dismiss the access request');
}

/**
 * A Telegram user's profile photo (JPEG), fetched through the Kortix API so the
 * bot token stays server-side. Null when the user has no visible photo.
 * `version` is `TelegramUser.photo_version`; it keys the HTTP cache.
 */
export function getTelegramUserPhoto(
  projectId: string,
  userId: string,
  version?: string | null,
  signal?: AbortSignal,
): Promise<Blob | null> {
  return userPhoto(projectId, 'telegram', userId, version, signal, 'Failed to load the Telegram photo');
}

/** The allowed users and the people who asked for access on one chat platform, with their names there. */
export function listChannelUsers(projectId: string, platform: ChannelAccessPlatform): Promise<ChannelUsers> {
  return channelUsers(projectId, platform, 'Failed to load the users');
}

/** Allow one user on a chat platform. Adds the id once and clears their access request. */
export function allowChannelUser(
  projectId: string,
  platform: ChannelAccessPlatform,
  userId: string,
): Promise<ChannelAccessList> {
  return allowUser(projectId, platform, userId, 'Failed to allow the user');
}

/** Remove one user from a chat platform's allowed list. Idempotent. */
export function removeChannelUser(
  projectId: string,
  platform: ChannelAccessPlatform,
  userId: string,
): Promise<ChannelAccessList> {
  return removeUser(projectId, platform, userId, 'Failed to remove the user');
}

/** Dismiss one access request on a chat platform without allowing the user. Idempotent. */
export function dismissChannelAccessRequest(
  projectId: string,
  platform: ChannelAccessPlatform,
  userId: string,
): Promise<ChannelAccessList> {
  return dismissRequest(projectId, platform, userId, 'Failed to dismiss the access request');
}

/**
 * A chat user's profile photo, fetched through the Kortix API so the bot
 * credential stays server-side. Null when the user has no visible photo. The
 * Blob's type is the image type (`image/jpeg` on Telegram).
 * `version` is `ChannelUser.photo_version`; it keys the HTTP cache.
 */
export function getChannelUserPhoto(
  projectId: string,
  platform: ChannelAccessPlatform,
  userId: string,
  version?: string | null,
  signal?: AbortSignal,
): Promise<Blob | null> {
  return userPhoto(projectId, platform, userId, version, signal, 'Failed to load the photo');
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

/**
 * The email provider a server runs: `'resend'` (Resend Inboxes). `'agentmail'`
 * is what servers before the Resend switch report.
 */
export type EmailProvider =
  | 'resend'
  /** @deprecated Older servers ran email on AgentMail. Removed in the next major. */
  | 'agentmail';

export interface EmailMode {
  provider: EmailProvider;
  enabled?: boolean;
  managed_available: boolean;
  /** Where a managed inbox lives: `<username>@<managed_domain>`. Older servers omit it. */
  managed_domain?: string;
}

const DEFAULT_EMAIL_MODE: EmailMode = { provider: 'resend', managed_available: false };

export async function getEmailInstallation(
  projectId: string,
  connectorSlug?: string | null,
): Promise<EmailConnectionInstallation | null> {
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
): Promise<EmailConnectionInstallation> {
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

/** A DNS record the email provider needs before a custom domain can send and receive. */
export interface EmailDomainRecord {
  type: 'TXT' | 'CNAME' | 'MX';
  name: string;
  value: string;
  status: 'MISSING' | 'INVALID' | 'VALID';
  priority?: number;
  reason?: string;
}

/** A domain an email account (Resend) can create inboxes on. `domain_id` is null for the managed domain. */
export interface EmailDomain {
  domain_id: string | null;
  domain: string;
  status: 'NOT_STARTED' | 'PENDING' | 'INVALID' | 'FAILED' | 'VERIFYING' | 'VERIFIED';
  /** `status === 'VERIFIED'`: an inbox can be created on it. */
  verified: boolean;
  records: EmailDomainRecord[];
  /** Why the domain is not verified yet, in the provider's words. */
  reason?: string;
}

export interface EmailDomainList {
  /** True when the list is the managed account's: one domain, no custom domains. */
  managed: boolean;
  default_domain: string;
  domains: EmailDomain[];
}

/** One-click DNS setup at the domain's DNS provider (Domain Connect), when it supports it. */
export interface EmailDomainSetup {
  url: string;
  provider_name: string | null;
  /** Another email provider's MX records already on the domain; applying replaces them. */
  conflicting_provider: string | null;
}

export interface EmailDomainResult {
  domain: EmailDomain;
  setup: EmailDomainSetup | null;
}

/**
 * The domains a Resend API key can create inboxes on. No `apiKey`: the
 * deployment's managed account, which offers its one managed domain. The key
 * travels in the POST body, never in a URL.
 */
export async function listEmailDomains(
  projectId: string,
  input: { apiKey?: string } = {},
): Promise<EmailDomainList> {
  return unwrap(
    await backendApi.post<EmailDomainList>(
      `/projects/${encodeURIComponent(projectId)}/channels/email/domains`,
      input.apiKey ? { api_key: input.apiKey } : {},
      { showErrors: false },
    ),
    'Failed to list email domains',
  );
}

/** Add a custom domain to the Resend account of `apiKey`; returns the DNS records to set. */
export async function addEmailDomain(
  projectId: string,
  input: { apiKey: string; domain: string },
): Promise<EmailDomainResult> {
  return unwrap(
    await backendApi.post<EmailDomainResult>(
      `/projects/${encodeURIComponent(projectId)}/channels/email/domains/add`,
      { api_key: input.apiKey, domain: input.domain },
      { showErrors: false },
    ),
    'Failed to add the email domain',
  );
}

/** Ask Resend to check a custom domain's DNS records again. */
export async function verifyEmailDomain(
  projectId: string,
  input: { apiKey: string; domainId: string },
): Promise<EmailDomainResult> {
  return unwrap(
    await backendApi.post<EmailDomainResult>(
      `/projects/${encodeURIComponent(projectId)}/channels/email/domains/verify`,
      { api_key: input.apiKey, domain_id: input.domainId },
      { showErrors: false },
    ),
    'Failed to check the email domain',
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
): Promise<EmailConnectionInstallation> {
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

// ── Email inboxes — the accounts of the project's email connector ──────────
// Each Resend inbox is one account of `kortix_email`: owned by one member
// (`owner_type: 'member'`, "only me") or shared with the project. Default,
// sharing and listing also work through the connection functions.

/** Who may email the agent, on the wire (snake_case). */
export interface EmailInboxSenderPolicy {
  mode: 'allow_all' | 'restricted';
  allowed_emails: string[];
  allowed_domains: string[];
  allowed_regex: string | null;
}

/** One email inbox: an account of the email connector. */
export interface EmailInbox {
  /** The account: pass it in `connector_bindings.email`. */
  connection_id: string;
  inbox_id: string;
  email: string;
  display_name: string | null;
  label: string;
  owner_type: 'member' | 'project';
  owner_id: string | null;
  is_default: boolean;
  /** On the deployment's managed Resend team (no own key). */
  managed: boolean;
  /** Kortix created the inbox: removing it deletes it on Resend. */
  created_by_kortix: boolean;
  sender_policy: EmailInboxSenderPolicy;
  /** The agent its mail starts; null = the project default. */
  agent_name: string | null;
  created_at: string;
}

export interface AddEmailInboxInput {
  /** `me`: only you ("only me"); `project` (default): shared with the project. */
  share?: 'me' | 'project';
  /** Your Resend API key; omit for a managed inbox when the deployment offers one. */
  api_key?: string;
  /** The part before the @. */
  username?: string;
  /** One of your Resend domains (own key), or the managed domain. */
  domain?: string;
  display_name?: string;
  label?: string;
  sender_policy?: Partial<EmailInboxSenderPolicy> | EmailSenderPolicy;
  agent_name?: string | null;
  /** Attach an existing Resend inbox by id instead of creating one. */
  inbox_id?: string;
}

export interface UpdateEmailInboxInput {
  sender_policy?: Partial<EmailInboxSenderPolicy> | EmailSenderPolicy;
  agent_name?: string | null;
  display_name?: string | null;
  label?: string;
}

export interface RemoveEmailInboxResult {
  status: 'deleted';
  /** True when Resend deleted the inbox (Kortix created it); false: only unlinked. */
  inbox_deleted: boolean;
}

/** The inboxes you can see: every shared one, and your own private ones. */
export async function listEmailInboxes(projectId: string): Promise<EmailInbox[]> {
  const data = unwrap(
    await backendApi.get<{ inboxes: EmailInbox[] }>(
      `/projects/${encodeURIComponent(projectId)}/channels/email/inboxes`,
      { showErrors: false },
    ),
    'Failed to list email inboxes',
  );
  return data.inboxes ?? [];
}

/** Add an inbox (a new account of the email connector). The key travels in the body. */
export async function addEmailInbox(projectId: string, input: AddEmailInboxInput): Promise<EmailInbox> {
  return unwrap(
    await backendApi.post<EmailInbox>(
      `/projects/${encodeURIComponent(projectId)}/channels/email/inboxes`,
      input,
      { showErrors: false },
    ),
    'Failed to add the email inbox',
  );
}

/** Change who may email an inbox, its agent, or its names. */
export async function updateEmailInbox(
  projectId: string,
  connectionId: string,
  input: UpdateEmailInboxInput,
): Promise<EmailInbox> {
  return unwrap(
    await backendApi.patch<EmailInbox>(
      `/projects/${encodeURIComponent(projectId)}/channels/email/inboxes/${encodeURIComponent(connectionId)}`,
      input,
      { showErrors: false },
    ),
    'Failed to update the email inbox',
  );
}

/** Remove an inbox. Resend deletes it too when Kortix created it. */
export async function removeEmailInbox(projectId: string, connectionId: string): Promise<RemoveEmailInboxResult> {
  return unwrap(
    await backendApi.delete<RemoveEmailInboxResult>(
      `/projects/${encodeURIComponent(projectId)}/channels/email/inboxes/${encodeURIComponent(connectionId)}`,
      { showErrors: false },
    ),
    'Failed to remove the email inbox',
  );
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
  /**
   * What a person recognizes: a channel's name without `#`, the other
   * person's name for a Slack DM, the members for a Slack group DM.
   */
  channelName: string | null;
  /**
   * Teams: `personal` | `groupChat` | `channel`. Slack: `channel` |
   * `private_channel` | `im` | `mpim`. Null until known.
   */
  channelType: string | null;
  /**
   * Slack answered that the conversation is deleted or out of the bot's
   * reach. Absent on servers older than this field.
   */
  channelUnavailable?: boolean;
  /**
   * A Teams channel thread: the title of its session. Every thread of a
   * channel is its own binding named `Team › Channel`; this tells them
   * apart. Null otherwise. Absent on servers older than this field.
   */
  threadTitle?: string | null;
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
