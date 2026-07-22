// Channel connectors — the unified surface for inbound chat/messaging channels
// (Slack, Teams, Email, Meet). Channels are `provider='channel'` connectors, so
// this is a thin sub-namespace of `connectors`: one generic client dispatches
// every channel by `platform` through the server-side descriptor registry.
// Adding a channel adds NO new SDK methods — pass the new platform string.
//
// (Channel→agent *bindings* — which agent/model a bound Slack channel uses —
// live at the bottom of this file; they are a separate concern from onboarding.)

import { backendApi } from '../../http/api-client';
import { unwrap } from './shared';

export type ChannelPlatform = 'slack' | 'teams' | 'email' | 'meet';

export interface ChannelSummary {
  platform: ChannelPlatform;
  label: string;
  direction: 'inbound';
  reservedSlug: string;
  enabled: boolean;
  capabilities: string[];
}

export interface ChannelsListResponse {
  channels: ChannelSummary[];
}

/** GET /connectors/channels — every registered channel + its install status. */
export async function listChannels(projectId: string): Promise<ChannelsListResponse> {
  return unwrap(
    await backendApi.get<ChannelsListResponse>(
      `/projects/${encodeURIComponent(projectId)}/connectors/channels`,
      { showErrors: false },
    ),
    'Failed to load channels',
  );
}

/** GET /connectors/channels/:platform/mode — onboarding info (OAuth availability, …). */
export async function getChannelMode<T = unknown>(
  projectId: string,
  platform: ChannelPlatform,
): Promise<T | null> {
  const res = await backendApi.get<T>(
    `/projects/${encodeURIComponent(projectId)}/connectors/channels/${encodeURIComponent(platform)}/mode`,
    { showErrors: false },
  );
  if (!res.success) return null;
  return res.data ?? null;
}

function slugQuery(slug?: string | null): string {
  return slug ? `?connector_slug=${encodeURIComponent(slug)}` : '';
}

/** GET /connectors/channels/:platform/installation — current install for `slug`, or null. */
export async function getChannelInstallation<T = unknown>(
  projectId: string,
  platform: ChannelPlatform,
  slug?: string | null,
): Promise<T | null> {
  const res = await backendApi.get<T | null>(
    `/projects/${encodeURIComponent(projectId)}/connectors/channels/${encodeURIComponent(platform)}/installation${slugQuery(slug)}`,
    { showErrors: false },
  );
  if (!res.success) return null;
  return (res.data ?? null) as T | null;
}

/** POST /connectors/channels/:platform/connect — provision/attach the install. */
export async function connectChannel<T = unknown>(
  projectId: string,
  platform: ChannelPlatform,
  config: Record<string, unknown>,
  slug?: string | null,
): Promise<T> {
  return unwrap(
    await backendApi.post<T>(
      `/projects/${encodeURIComponent(projectId)}/connectors/channels/${encodeURIComponent(platform)}/connect${slugQuery(slug)}`,
      config,
      { showErrors: false },
    ),
    'Failed to connect channel',
  );
}

/** DELETE /connectors/channels/:platform/installation — tear down the install. */
export async function disconnectChannel(
  projectId: string,
  platform: ChannelPlatform,
  slug?: string | null,
): Promise<void> {
  const res = await backendApi.delete(
    `/projects/${encodeURIComponent(projectId)}/connectors/channels/${encodeURIComponent(platform)}/installation${slugQuery(slug)}`,
    { showErrors: false },
  );
  if (!res.success) throw new Error(res.error?.message ?? 'Failed to disconnect channel');
}

/**
 * Invoke a runtime capability declared by the channel's descriptor —
 * `POST/GET/PUT/DELETE /connectors/channels/:platform/actions/:action`. The
 * capability's HTTP method must match `method` (default 'post'). For GET
 * capabilities, `input` is sent as the query string; otherwise as the JSON body.
 */
export async function channelAction<T = unknown>(
  projectId: string,
  platform: ChannelPlatform,
  action: string,
  input?: Record<string, unknown>,
  method: 'get' | 'post' | 'put' | 'delete' = 'post',
): Promise<T> {
  const base = `/projects/${encodeURIComponent(projectId)}/connectors/channels/${encodeURIComponent(platform)}/actions/${encodeURIComponent(action)}`;
  if (method === 'get') {
    const qs = input
      ? `?${new URLSearchParams(input as Record<string, string>).toString()}`
      : '';
    return unwrap(
      await backendApi.get<T>(`${base}${qs}`, { showErrors: false }),
      `Failed to run ${action}`,
    );
  }
  const opts = { showErrors: false } as const;
  const res =
    method === 'put'
      ? await backendApi.put<T>(base, input ?? {}, opts)
      : method === 'delete'
        ? await backendApi.delete<T>(base, opts)
        : await backendApi.post<T>(base, input ?? {}, opts);
  return unwrap(res, `Failed to run ${action}`);
}

// ── Typed config/response shapes (optional ergonomics over the generic calls) ──
// These describe the provider-specific connect payloads/summaries so callers can
// do e.g. `connectChannel<EmailInstallation>(id, 'email', input)`. The runtime
// surface stays generic — these are types only.

export interface ConnectSlackInput {
  bot_token: string;
  signing_secret: string;
}

/**
 * The per-project (BYO) Slack app manifest JSON. Served from the PUBLIC webhook
 * route (not a channel connector capability) because the in-sandbox
 * `kortix-agent slack manifest` command fetches it unauthenticated. Kept as a
 * standalone helper for exactly that reason.
 */
export async function getSlackManifest(projectId: string): Promise<Record<string, unknown>> {
  return unwrap(
    await backendApi.get<Record<string, unknown>>(
      `/webhooks/slack/${encodeURIComponent(projectId)}/manifest`,
      { showErrors: false },
    ),
    'Failed to load Slack manifest',
  );
}

export interface SlackInstallation {
  workspaceId: string;
  workspaceName: string | null;
  botUserId: string | null;
  installedAt: string;
}

/** Response shape of the slack channel's `mode` (onboarding info). */
export interface SlackMode {
  oauth_available: boolean;
  install_url: string | null;
}

/** Response shape of the email channel's `mode` (onboarding info). */
export interface EmailMode {
  provider: 'agentmail';
  enabled?: boolean;
  managed_available: boolean;
}

export interface EmailSenderPolicy {
  mode: 'allow_all' | 'restricted';
  allowedEmails: string[];
  allowedDomains: string[];
  allowedRegex: string | null;
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

export interface EmailInstallation {
  profile_id: string | null;
  profileSlug: string;
  inboxId: string;
  email: string;
  displayName: string | null;
  webhookId: string | null;
  senderPolicy: EmailSenderPolicy;
  installedAt: string;
}

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

// ── Channel bindings — which agent/model/join-policy a bound chat channel uses ──
// The web management surface for `chat_channel_bindings`. Orthogonal to channel
// onboarding above — this is about routing an already-connected channel to an
// agent. Still served at /channels/bindings (a binding is not a connector).

export type ChannelConversationPolicy = 'owner_approval' | 'owner_only' | 'project_open';

export interface ChannelBindingEffectiveAgent {
  agent: string;
  source: 'explicit' | 'project' | 'fallback';
}

/** Where an effective model came from — mirrors llm-gateway/resolution/effective.ts `ModelSource`. */
export type ChannelBindingModelSource = 'explicit' | 'agent' | 'project' | 'account' | 'platform';

export interface ChannelBindingEffectiveModel {
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
  agentName?: string | null;
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
