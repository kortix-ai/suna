/**
 * Slack and Teams connector reads, confined to the calling project's own
 * conversations.
 *
 * The managed Slack app has one bot token per workspace, and the managed Teams
 * app mints one Graph token per tenant. Every project connected to the same
 * workspace or tenant resolves that SAME credential (`channelToken` in
 * db-deps.ts). The token alone let an agent in one project read every
 * conversation the bot is in: other projects' channels, DMs and threads
 * included (found in the 2026-09-29 permissions audit). This module is the rule
 * the gateway applies on top of the token.
 *
 * THE RULE. A read reaches a conversation only when it belongs to the calling
 * project:
 *   1. A conversation or thread that belongs to another project is refused.
 *   2. One that belongs to this project is allowed.
 *   3. One that belongs to no project is allowed only while no other project is
 *      connected to the same Slack workspace or Teams tenant.
 *
 * Ownership comes from rows only the chat paths write:
 *   - A thread belongs to its session's project (`chat_threads`). A thread's
 *     owner wins over its channel's: a session that posted into a channel
 *     reads its own thread there.
 *   - A Slack channel or DM belongs to the project it is bound to
 *     (`chat_channel_bindings`).
 *   - Teams binds each conversation, and every channel post is its own
 *     conversation (`19:…@thread.tacv2;messageid=…`). A Teams channel belongs
 *     to every project that has a conversation in it, and a per-thread binding
 *     decides a thread no session owns.
 *
 * Not confined here: directory reads (people, teams, team members, the bot's
 * own identity) and the metadata of public Slack channels and standard Teams
 * channels. Every project in a workspace shares one directory, and the
 * platform shows it to every member. Writes are not confined here either.
 */
import { and, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import { chatChannelBindings, chatInstalls, chatThreads } from '@kortix/db';
import { db } from '../shared/db';

export const CONVERSATION_NOT_IN_PROJECT = 'conversation_not_in_project';

export interface ChannelReadRefusal {
  reason: typeof CONVERSATION_NOT_IN_PROJECT;
  /** What the agent reads: which conversation, why, and how to fix it. */
  message: string;
}

export interface ChannelReadInput {
  projectId: string;
  /** The channel connector's platform. Only `slack` and `teams` are confined. */
  platform: string | null;
  actionPath: string;
  args: Record<string, unknown>;
  risk: string;
}

/** The confinement of one call: checked before the provider call, then on its answer. */
export interface ChannelReadGate {
  /** Set when the read must not reach the provider at all. */
  refusal: ChannelReadRefusal | null;
  /** The provider's successful answer as this project may see it, or a refusal. */
  answer(data: unknown): Promise<Answer>;
}

type Platform = 'slack' | 'teams';

/**
 * How each catalog action touches conversations. A unit test fails when a
 * Slack or Teams catalog action has no entry, so a new action is classified
 * before it ships. A read action missing here is refused at call time.
 */
export type ChannelReadScope =
  /** The args name one channel; the channel decides. Checked before the call. */
  | 'channel'
  /** The args name one thread; its owner, else its channel, decides. Checked before the call. */
  | 'thread'
  /** One channel's metadata: public/standard passes, any other as `channel`. Checked on the answer. */
  | 'channel_meta'
  /** A list of channels: public/standard kept, any other kept only when readable. */
  | 'channel_list'
  /** A file: readable when one of the conversations it is shared in is readable. */
  | 'file'
  /** A search across every conversation: only while no other project shares the workspace. */
  | 'workspace'
  /** People, teams, the bot itself: no conversation. */
  | 'directory'
  /** Not a read. */
  | 'write';

export const CHANNEL_READ_SCOPES: Record<Platform, Record<string, ChannelReadScope>> = {
  slack: {
    get_history: 'channel',
    get_thread: 'thread',
    channel_info: 'channel_meta',
    list_channels: 'channel_list',
    file_info: 'file',
    search_messages: 'workspace',
    list_users: 'directory',
    user_info: 'directory',
    auth_test: 'directory',
    send_message: 'write',
    update_message: 'write',
    delete_message: 'write',
    add_reaction: 'write',
    remove_reaction: 'write',
    join_channel: 'write',
  },
  teams: {
    list_messages: 'channel',
    get_message: 'thread',
    list_replies: 'thread',
    get_channel: 'channel_meta',
    list_channels: 'channel_list',
    get_team: 'directory',
    list_members: 'directory',
    get_user: 'directory',
    list_teams: 'directory',
  },
};

/** What the database says about who owns what. Injected so the decisions test without a database. */
export interface ChannelOwnership {
  /** The workspaces (Slack teams, Teams tenants) this project's install proved, and whether another project is connected to one of them. */
  installs(projectId: string, platform: Platform): Promise<{ workspaceIds: string[]; shared: boolean }>;
  /** The projects each channel belongs to, keyed by normalized channel id. */
  channelProjects(platform: Platform, workspaceIds: string[], channelIds: string[]): Promise<Map<string, Set<string>>>;
  /** The project each owned thread belongs to, keyed by normalized thread id. Unowned threads are absent. */
  threadOwners(platform: Platform, workspaceIds: string[], threadIds: string[]): Promise<Map<string, string>>;
}

type Owner = 'mine' | 'other' | 'none';

interface Scope {
  projectId: string;
  platform: Platform;
  workspaceIds: string[];
  shared: boolean;
  ownership: ChannelOwnership;
}

const PASS: ChannelReadGate = { refusal: null, answer: async (data) => ({ data }) };

/**
 * The gate for one channel connector call. Queries run only for the actions
 * that need them: a directory read or a write costs nothing.
 */
export async function gateChannelRead(
  input: ChannelReadInput,
  ownership: ChannelOwnership = dbChannelOwnership,
): Promise<ChannelReadGate> {
  const platform = input.platform === 'slack' || input.platform === 'teams' ? input.platform : null;
  if (!platform) return PASS;
  const scopes = CHANNEL_READ_SCOPES[platform];
  const kind = Object.hasOwn(scopes, input.actionPath) ? scopes[input.actionPath] : undefined;
  if (!kind) {
    if (input.risk !== 'read') return PASS;
    return refuse(`The ${label(platform)} connector does not run read action "${input.actionPath}": it has no rule that keeps it to this project's conversations.`);
  }
  if (kind === 'directory' || kind === 'write') return PASS;

  const installs = await ownership.installs(input.projectId, platform);
  const scope: Scope = { projectId: input.projectId, platform, ...installs, ownership };

  if (kind === 'workspace') {
    return mayReadUnowned(scope)
      ? PASS
      : refuse(
          scope.workspaceIds.length === 0
            ? noInstall(platform)
            : `${input.actionPath} does not run while this Slack workspace is connected to more than one Kortix project: a search cannot be limited to this project's conversations. Read a channel with get_history or a thread with get_thread instead.`,
        );
  }
  if (kind === 'channel' || kind === 'thread') return gateTarget(scope, kind, input);
  return { refusal: null, answer: (data) => scopeAnswer(scope, kind, input, data) };
}

async function gateTarget(scope: Scope, kind: 'channel' | 'thread', input: ChannelReadInput): Promise<ChannelReadGate> {
  const target = parseTarget(scope.platform, kind, input.args);
  if ('invalid' in target) return refuse(target.invalid);
  const threadOwner = target.thread
    ? ((await threadOwners(scope, [target.thread])).get(target.thread) ?? 'none')
    : 'none';
  if (threadOwner === 'other') return refuse(otherProject(scope.platform, target.subject));
  if (threadOwner === 'none') {
    const refusal = await channelRefusal(scope, target.channel, target.subject);
    if (refusal) return refuse(refusal);
  }
  return { refusal: null, answer: (data) => scopeMessages(scope, kind, target, data) };
}

/** Why this project may not read the channel, or null when it may. */
async function channelRefusal(scope: Scope, channel: string, subject: string): Promise<string | null> {
  const owner = (await channelOwners(scope, [channel])).get(channel) ?? 'none';
  return readable(scope, owner) ? null : refusalMessage(scope, owner, subject);
}

/**
 * The messages of a thread or a channel as this project may see them.
 *
 * A channel read drops every message of a thread another project owns: its
 * root and any reply broadcast to the channel. A thread read is refused when
 * the provider answered with a thread other than the one checked (Slack
 * answers a reply's `ts` with its whole thread).
 */
async function scopeMessages(scope: Scope, kind: 'channel' | 'thread', target: Target, data: unknown): Promise<Answer> {
  const key = scope.platform === 'slack' ? 'messages' : 'value';
  // Graph answers `get_message` with the message itself, not a list.
  const list = listOf(data, key) ?? (scope.platform === 'teams' && kind === 'thread' && isRecord(data) ? [data] : null);
  if (!list) return { data };
  const rootOf = (m: unknown) => messageThread(scope.platform, target.channel, m);
  const roots = [...new Set(list.map(rootOf).filter((r): r is string => !!r && r !== target.thread))];
  if (roots.length === 0) return { data };
  const owners = await threadOwners(scope, roots);
  if (kind === 'thread') {
    return [...owners.values()].includes('other') ? deny(otherProject(scope.platform, target.subject)) : { data };
  }
  const kept = list.filter((m) => owners.get(rootOf(m) ?? '') !== 'other');
  return { data: kept.length === list.length ? data : { ...(data as Record<string, unknown>), [key]: kept } };
}

/** Channel metadata, channel lists, and files: decided on the provider's answer. */
async function scopeAnswer(scope: Scope, kind: ChannelReadScope, input: ChannelReadInput, data: unknown): Promise<Answer> {
  const slack = scope.platform === 'slack';
  if (kind === 'channel_meta') {
    const channel = slack ? (isRecord(data) ? data.channel : null) : data;
    if (!isRecord(channel) || isOpenChannel(scope.platform, channel)) return { data };
    const id =
      normalizedId(scope.platform, channel.id) ?? normalizedId(scope.platform, input.args[slack ? 'channel' : 'channel-id']) ?? '';
    const refusal = await channelRefusal(scope, id, `${slack ? 'Slack conversation' : 'Teams channel'} ${id}`);
    return refusal ? deny(refusal) : { data };
  }
  if (kind === 'channel_list') {
    const key = slack ? 'channels' : 'value';
    const list = listOf(data, key);
    if (!list) return { data };
    const closedIds = list
      .filter((c) => isRecord(c) && !isOpenChannel(scope.platform, c))
      .map((c) => normalizedId(scope.platform, (c as Record<string, unknown>).id))
      .filter((id): id is string => !!id);
    const owners = await channelOwners(scope, closedIds);
    const kept = list.filter((c) => {
      if (!isRecord(c)) return false;
      if (isOpenChannel(scope.platform, c)) return true;
      const id = normalizedId(scope.platform, c.id);
      return !!id && readable(scope, owners.get(id) ?? 'none');
    });
    return { data: kept.length === list.length ? data : { ...(data as Record<string, unknown>), [key]: kept } };
  }
  if (kind === 'file' && isRecord(data) && isRecord(data.file)) {
    const file = data.file;
    const ids = [file.channels, file.groups, file.ims]
      .flatMap((v) => (Array.isArray(v) ? v : []))
      .map((id) => normalizedId(scope.platform, id))
      .filter((id): id is string => !!id);
    // A file shared nowhere belongs to no conversation.
    const owners = ids.length ? [...(await channelOwners(scope, ids)).values()] : ['none' as const];
    if (owners.some((owner) => readable(scope, owner))) return { data };
    const subject = `Slack file ${typeof file.id === 'string' ? file.id : ''}`.trim();
    return deny(refusalMessage(scope, owners.includes('other') ? 'other' : 'none', subject));
  }
  return { data };
}

/* ─── ids ───────────────────────────────────────────────────────────────────── */

interface Target {
  /** Normalized channel id. */
  channel: string;
  /** Normalized thread id, for a thread read. */
  thread?: string;
  /** How the refusal names it. */
  subject: string;
}

const SLACK_ID = /^[A-Za-z0-9]{2,64}$/;
const SLACK_TS = /^\d{1,12}\.\d{1,9}$/;
const TEAMS_CHANNEL = /^19:[A-Za-z0-9._=-]{1,256}@thread\.[A-Za-z0-9]{1,16}$/;
const TEAMS_MESSAGE = /^\d{1,24}$/;

/**
 * An id as the ownership rows store it: Slack ids uppercase, Teams ids
 * lowercase (compared lowercase on both sides). Any other shape is refused,
 * not looked up: a padded or re-encoded id could match no row here and still
 * name a real conversation at the provider.
 */
function normalizedId(platform: Platform, value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (platform === 'slack') return SLACK_ID.test(value) ? value.toUpperCase() : null;
  return TEAMS_CHANNEL.test(value) ? value.toLowerCase() : null;
}

function teamsThreadId(channel: string, messageId: string): string {
  return `${channel};messageid=${messageId}`.toLowerCase();
}

function parseTarget(
  platform: Platform,
  kind: 'channel' | 'thread',
  args: Record<string, unknown>,
): Target | { invalid: string } {
  if (platform === 'slack') {
    const channel = normalizedId('slack', args.channel);
    if (!channel) return { invalid: '`channel` must be one Slack conversation id, for example C0123ABCD.' };
    if (kind === 'channel') return { channel, subject: `Slack conversation ${channel}` };
    const ts = typeof args.ts === 'string' && SLACK_TS.test(args.ts) ? args.ts : null;
    if (!ts) return { invalid: '`ts` must be one Slack message timestamp, for example 1700000000.000100.' };
    return { channel, thread: ts, subject: `Slack thread ${ts} in ${channel}` };
  }
  const channel = normalizedId('teams', args['channel-id']);
  if (!channel) return { invalid: '`channel-id` must be one Teams channel id, for example 19:abc@thread.tacv2.' };
  if (kind === 'channel') return { channel, subject: `Teams channel ${channel}` };
  const message = args['message-id'];
  if (typeof message !== 'string' || !TEAMS_MESSAGE.test(message)) {
    return { invalid: '`message-id` must be one Teams message id (digits).' };
  }
  return { channel, thread: teamsThreadId(channel, message), subject: `Teams thread ${message} in ${channel}` };
}

/** The thread a provider message belongs to, normalized. */
function messageThread(platform: Platform, channel: string, message: unknown): string | null {
  if (!isRecord(message)) return null;
  if (platform === 'slack') {
    const root = message.thread_ts ?? message.ts;
    return typeof root === 'string' ? root : null;
  }
  const root = message.replyToId || message.id;
  return typeof root === 'string' && TEAMS_MESSAGE.test(root) ? teamsThreadId(channel, root) : null;
}

/** A public Slack channel or a standard Teams channel: its metadata is directory data. */
function isOpenChannel(platform: Platform, channel: Record<string, unknown>): boolean {
  if (platform === 'teams') return channel.membershipType === 'standard';
  return channel.is_private === false && channel.is_im !== true && channel.is_mpim !== true;
}

/* ─── decisions ─────────────────────────────────────────────────────────────── */

function mayReadUnowned(scope: Scope): boolean {
  return scope.workspaceIds.length > 0 && !scope.shared;
}

function readable(scope: Scope, owner: Owner): boolean {
  return owner === 'mine' || (owner === 'none' && mayReadUnowned(scope));
}

async function channelOwners(scope: Scope, ids: string[]): Promise<Map<string, Owner>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0 || scope.workspaceIds.length === 0) return new Map();
  const projects = await scope.ownership.channelProjects(scope.platform, scope.workspaceIds, unique);
  return new Map(
    unique.map((id) => {
      const owners = projects.get(id);
      return [id, owners?.has(scope.projectId) ? 'mine' : owners?.size ? 'other' : 'none'];
    }),
  );
}

async function threadOwners(scope: Scope, ids: string[]): Promise<Map<string, Owner>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0 || scope.workspaceIds.length === 0) return new Map();
  const owners = await scope.ownership.threadOwners(scope.platform, scope.workspaceIds, unique);
  return new Map([...owners].map(([id, projectId]) => [id, projectId === scope.projectId ? 'mine' : 'other']));
}

/* ─── messages ──────────────────────────────────────────────────────────────── */

function label(platform: Platform): string {
  return platform === 'slack' ? 'Slack' : 'Microsoft Teams';
}

type Answer = { data: unknown } | { refusal: ChannelReadRefusal };

function deny(message: string): { refusal: ChannelReadRefusal } {
  return { refusal: { reason: CONVERSATION_NOT_IN_PROJECT, message } };
}

function refuse(message: string): ChannelReadGate {
  return { ...deny(message), answer: PASS.answer };
}

function noInstall(platform: Platform): string {
  return `This project has no ${label(platform)} install on record, so the connector cannot tell which conversations are its own. Connect ${label(platform)} again in Settings → Channels.`;
}

function otherProject(platform: Platform, subject: string): string {
  return `${subject} belongs to another Kortix project. This project's ${label(platform)} connector reads only its own conversations.`;
}

function refusalMessage(scope: Scope, owner: Owner, subject: string): string {
  if (scope.workspaceIds.length === 0) return noInstall(scope.platform);
  if (owner === 'other') return otherProject(scope.platform, subject);
  return scope.platform === 'slack'
    ? `${subject} is not connected to this project, and this Slack workspace is connected to more than one Kortix project. Connect it first: run \`/kortix switch\` in that conversation and pick this project.`
    : `This project has no conversation in ${subject}, and this Microsoft 365 tenant is connected to more than one Kortix project. Mention the bot in that channel and pick this project first.`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function listOf(data: unknown, key: string): unknown[] | null {
  return isRecord(data) && Array.isArray(data[key]) ? (data[key] as unknown[]) : null;
}

/* ─── database ──────────────────────────────────────────────────────────────── */

export const dbChannelOwnership: ChannelOwnership = {
  async installs(projectId, platform) {
    const rows = await db
      .select({ workspaceId: chatInstalls.workspaceId })
      .from(chatInstalls)
      .where(and(eq(chatInstalls.platform, platform), eq(chatInstalls.projectId, projectId)));
    const workspaceIds = [...new Set(rows.map((r) => r.workspaceId).filter(Boolean))];
    if (workspaceIds.length === 0) return { workspaceIds, shared: false };
    const [other] = await db
      .select({ projectId: chatInstalls.projectId })
      .from(chatInstalls)
      .where(
        and(
          eq(chatInstalls.platform, platform),
          inArray(chatInstalls.workspaceId, workspaceIds),
          ne(chatInstalls.projectId, projectId),
        ),
      )
      .limit(1);
    return { workspaceIds, shared: Boolean(other) };
  },

  async channelProjects(platform, workspaceIds, channelIds) {
    const out = new Map<string, Set<string>>();
    const add = (id: string, projectId: string | null) => {
      if (!projectId) return;
      const set = out.get(id) ?? new Set<string>();
      set.add(projectId);
      out.set(id, set);
    };
    if (platform === 'slack') {
      const rows = await db
        .select({ id: chatChannelBindings.channelId, projectId: chatChannelBindings.projectId })
        .from(chatChannelBindings)
        .where(
          and(
            eq(chatChannelBindings.platform, 'slack'),
            inArray(chatChannelBindings.workspaceId, workspaceIds),
            inArray(chatChannelBindings.channelId, channelIds),
            isNotNull(chatChannelBindings.projectId),
          ),
        );
      for (const r of rows) add(r.id, r.projectId);
      return out;
    }
    // A Teams conversation id is its channel id plus `;messageid=<root>` for a
    // channel thread, so the channel is the part before the first `;`.
    const bindingChannel = sql<string>`lower(split_part(${chatChannelBindings.channelId}, ';', 1))`;
    const threadChannel = sql<string>`lower(split_part(${chatThreads.threadId}, ';', 1))`;
    const [bindings, threads] = await Promise.all([
      db
        .select({ id: bindingChannel, projectId: chatChannelBindings.projectId })
        .from(chatChannelBindings)
        .where(
          and(
            eq(chatChannelBindings.platform, 'teams'),
            inArray(chatChannelBindings.workspaceId, workspaceIds),
            inArray(bindingChannel, channelIds),
            isNotNull(chatChannelBindings.projectId),
          ),
        ),
      db
        .select({ id: threadChannel, projectId: chatThreads.projectId })
        .from(chatThreads)
        .where(
          and(
            eq(chatThreads.platform, 'teams'),
            inArray(chatThreads.workspaceId, workspaceIds),
            inArray(threadChannel, channelIds),
          ),
        ),
    ]);
    for (const r of [...bindings, ...threads]) add(r.id, r.projectId);
    return out;
  },

  async threadOwners(platform, workspaceIds, threadIds) {
    const threadId =
      platform === 'teams' ? sql<string>`lower(${chatThreads.threadId})` : sql<string>`${chatThreads.threadId}`;
    const threads = await db
      .select({ id: threadId, projectId: chatThreads.projectId })
      .from(chatThreads)
      .where(
        and(
          eq(chatThreads.platform, platform),
          inArray(chatThreads.workspaceId, workspaceIds),
          inArray(threadId, threadIds),
        ),
      );
    const out = new Map(threads.map((r) => [r.id, r.projectId]));
    if (platform === 'slack') return out;
    // A Teams channel thread can be bound to a project before any session
    // owns it. The session, when there is one, decides.
    const bindingId = sql<string>`lower(${chatChannelBindings.channelId})`;
    const bindings = await db
      .select({ id: bindingId, projectId: chatChannelBindings.projectId })
      .from(chatChannelBindings)
      .where(
        and(
          eq(chatChannelBindings.platform, 'teams'),
          inArray(chatChannelBindings.workspaceId, workspaceIds),
          inArray(bindingId, threadIds),
          isNotNull(chatChannelBindings.projectId),
        ),
      );
    for (const r of bindings) if (r.projectId && !out.has(r.id)) out.set(r.id, r.projectId);
    return out;
  },
};
