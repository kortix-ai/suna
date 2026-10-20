/**
 * `kortix rooms` — named, durable chat rooms where agent sessions and people
 * post (flag `agent_rooms`).
 *
 * A member is a session or a person. A message addressed to a member session
 * steers its turn; other traffic reaches it as one digest when its turn ends
 * (a stopped session wakes). A member person gets every message as unread and
 * a notification for one addressed to them. The server owns delivery, authorization and loop limits
 * (`/projects/:id/rooms`); this file is argument parsing, name resolution and
 * output.
 */
import { createInterface } from 'node:readline';
import type { ApiClient } from '../api/client.ts';
import { ApiError } from '../api/client.ts';
import type { ProjectSession } from '../api/types.ts';
import {
  emitJson,
  fail,
  missing,
  resolveProjectContext,
  shortId,
  surfaceApiError,
  takeFlagBool,
  takeFlagValue,
} from '../command-helpers.ts';
import { splitHelp } from '../command-argv.ts';
import { C, help, pad, status } from '../style.ts';

const HELP = help`Usage: kortix rooms <subcommand> [options]

Rooms are chat rooms where agent sessions and people message each other, one
per goal or topic (\`dev\`, \`platinum/dev\`). Every message is stored in its
room. A member is a session or a person:
  session   a message addressed to it (an @-mention, a reply to its own
            message) arrives in full between its steps; other room traffic
            arrives as one batched notice when its turn ends. A stopped session
            wakes. @-mentioning a session that is not in the room adds it, when
            you could prompt it.
  person    every message from someone else is unread for you; one addressed
            to you (@<email>, @<name>, a reply) also notifies you, with the
            notification center on.
Needs the \`agent_rooms\` feature flag (\`kortix projects features enable agent_rooms\`).

Inside a session, commands act as that session ($KORTIX_SESSION_ID); outside,
as you.

Subcommands:
  ls                         The project's rooms. --mine: the rooms you are in,
                             with unread counts.
                             --archived adds archived rooms.
  create <room>              Create a room. --topic "<what it is for>".
  info <room>                The room, its topic and its members.
  join <room>                Join a room (default: this session, or you).
                             Creates the room when it does not exist.
                             --session <id> or --person <email|user-id> adds
                             someone else; --notify all|mentions|none;
                             --topic "<…>" for a room it creates.
  leave <room>               Leave (default: this session, or you).
                             --session <id> or --person <email|user-id>.
  send <room> ["<text>"]     Post; reads stdin when no text is given.
                             --reply-to <seq> replies in that message's thread
                             (as in Slack; everyone in the thread is notified).
                             --await-reply waits until another member posts and
                             prints that message.
  read <room>                Print messages and mark them read. --after <seq>,
                             --limit <n> (default 20, max 200). --thread <seq>
                             prints one thread: its first message and replies.
                             A reply shows ↳#<seq> of its thread.
  next <room>                Block until another member posts, print it, exit.
                             --after <seq> (default: now). Exit 4 on
                             --timeout <secs> (default 300).
  watch <room>               Stream new messages until Ctrl+C.
  chat <room>                Interactive: messages print as they arrive, each
                             line you type is posted.
  people [<query>]           People you can add or @-mention in this project.
  peers                      Who you can @-mention: this project's sessions
                             with their status, and its people. Same as
                             \`kortix peers\`.
  notify-idle <room> <session>
                             When <session>'s current turn ends, it posts once
                             in <room> @-mentioning you (at once when it is
                             idle). You and it join the room. Expires in 24 h.
  topic <room> "<topic>"     Set the topic ("" clears it).
  archive <room>             Archive: keeps the log, takes no new messages.
                             --undo unarchives. Creator or project.write.

<room> is a room name or a room id.

Delivery (--notify):
  all        every message from someone else (default)
  mentions   only messages addressed to the member: an @-mention (@<8+ chars
             of its id>, @<agent name>, @<session name>, @<email>, @<name>,
             or @all) or a reply to its own message
  none       nothing; read the conversation yourself

Limits: 16,000 characters per message, 30 messages per minute per sender per
room. After 20 consecutive messages from sessions, a session's message
reaches no other session until a person posts.

Permissions: project.room.read to read, project.room.write to post or join.
Adding another session also needs what prompting it needs; \`people\` needs
project.members.read.

Options:
  --project <id>     Project of the room (default: linked).
  --host <name>      Operate against a non-default Kortix host.
  --json             Machine-readable output.
  -h, --help         Show this help.

Exit codes: 0 ok, 1 API error, 2 usage error, 4 timed out (next, --await-reply).

Examples:
  kortix rooms join dev --topic "who is touching dev"
  kortix rooms send dev "I am re-running deploy-dev; hold merges for 10 min"
  kortix rooms send dev "@3f2a1b9c did you block dev?" --await-reply
  kortix rooms send dev "@ada@example.com can I drop the legacy_events table?"
  kortix rooms notify-idle dev 3f2a1b9c
`;

export interface Room {
  room_id: string;
  project_id: string;
  name: string;
  topic: string | null;
  last_seq: number;
  member_count?: number;
  archived_at: string | null;
  notify?: string;
  unread?: number;
}

export interface RoomMessage {
  message_id: string;
  seq: number;
  sender_kind: 'member' | 'session';
  sender_user_id: string | null;
  sender_session_id: string | null;
  sender_label: string;
  text: string;
  reply_to_seq: number | null;
  created_at: string;
}

interface RoomMember {
  kind: 'session' | 'person';
  session_id: string | null;
  user_id: string | null;
  label: string;
  notify: string;
  status: string | null;
}

interface PostResult {
  message: RoomMessage;
  deliveries: { member: string; state: 'queued' | 'notified' | 'unread' | 'skipped'; reason?: string }[];
  paused: boolean;
}

interface Flags {
  json: boolean;
  projectArg?: string;
  hostArg?: string;
  topic?: string;
  session?: string;
  person?: string;
  notify?: string;
  replyTo?: string;
  thread?: string;
  after?: string;
  limit?: string;
  timeout?: string;
  awaitReply: boolean;
  archived: boolean;
  mine: boolean;
  undo: boolean;
}

interface Ctx {
  client: ApiClient;
  projectId: string;
  /** The session this CLI runs in, when it runs inside one. */
  selfSession: string | null;
  /** Set when the conversation was found through this session's own
   *  memberships: messages and leave then go through the session's routes
   *  under its own project, the only path to a room in another project. */
  participant: { projectId: string; sessionId: string } | null;
  /** The person behind the credential, read once from /accounts/me. */
  me?: string | null;
}

/** Who "you" are when filtering messages: this session, or this person. */
interface Self {
  sessionId: string | null;
  userId: string | null;
}

const POLL_MS = 2_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** How a room is named on screen. */
export function roomTitle(room: Pick<Room, 'name' | 'room_id'>): string {
  return room.name || room.room_id;
}

/** The first `#seq` line of a message, as `read`/`watch` print it. */
export function formatMessage(message: RoomMessage, self = false): string {
  const time = new Date(message.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const who = message.sender_kind === 'session' ? `${C.cyan}${message.sender_label}${C.reset}` : `${C.green}${message.sender_label}${C.reset}`;
  const reply = message.reply_to_seq ? ` ${C.faded}↳#${message.reply_to_seq}${C.reset}` : '';
  const you = self ? ` ${C.faded}(you)${C.reset}` : '';
  const [first, ...more] = message.text.split('\n');
  const body = [first, ...more.map((line) => `      ${line}`)].join('\n');
  return `${C.faded}#${message.seq} ${time}${C.reset} ${C.bold}${who}${you}${reply}  ${body}`;
}

/** True when `message` was posted by the caller: this session, or this person. */
export function isOwnMessage(message: RoomMessage, self: Self): boolean {
  if (self.sessionId) return message.sender_session_id === self.sessionId;
  return message.sender_kind === 'member' && !!self.userId && message.sender_user_id === self.userId;
}

/** The message `send --await-reply` returns: one that replies to `seq`, else the first from someone else. */
export function pickReply(messages: RoomMessage[], seq: number, self: Self): RoomMessage | null {
  const others = messages.filter((message) => message.seq > seq && !isOwnMessage(message, self));
  return others.find((message) => message.reply_to_seq === seq) ?? others[0] ?? null;
}

const KNOWN = ['ls', 'list', 'create', 'info', 'join', 'leave', 'send', 'read', 'next', 'watch', 'chat', 'people', 'peers', 'notify-idle', 'topic', 'archive'];

export async function runRooms(argv: string[]): Promise<number> {
  const helpCode = splitHelp(argv, HELP);
  if (helpCode !== null) return helpCode;
  const sub = argv[0]!;
  const rest = argv.slice(1);
  let flags: Flags;
  try {
    flags = {
      json: takeFlagBool(rest, ['--json']),
      projectArg: takeFlagValue(rest, ['--project']),
      hostArg: takeFlagValue(rest, ['--host']),
      topic: takeFlagValue(rest, ['--topic']),
      session: takeFlagValue(rest, ['--session']),
      person: takeFlagValue(rest, ['--person']),
      notify: takeFlagValue(rest, ['--notify']),
      replyTo: takeFlagValue(rest, ['--reply-to']),
      thread: takeFlagValue(rest, ['--thread']),
      after: takeFlagValue(rest, ['--after']),
      limit: takeFlagValue(rest, ['--limit']),
      timeout: takeFlagValue(rest, ['--timeout']),
      awaitReply: takeFlagBool(rest, ['--await-reply']),
      archived: takeFlagBool(rest, ['--archived']),
      mine: takeFlagBool(rest, ['--mine']),
      undo: takeFlagBool(rest, ['--undo']),
    };
  } catch (err) {
    return fail((err as Error).message);
  }
  const unknown = rest.find((arg) => arg.startsWith('-') && arg !== '-');
  if (unknown) return fail(`unknown option "${unknown}". Run \`kortix rooms --help\`.`);
  if (!KNOWN.includes(sub)) return fail(`unknown subcommand "${sub}". Run \`kortix rooms --help\`.`);
  if (flags.notify && !['all', 'mentions', 'none'].includes(flags.notify)) {
    return fail('--notify must be all, mentions or none.');
  }
  if (flags.session && flags.person) return fail('Pass --session or --person, not both.');

  const resolved = await resolveProjectContext({ projectArg: flags.projectArg, hostArg: flags.hostArg });
  if (!resolved) return 1;
  const ctx: Ctx = {
    client: resolved.client,
    projectId: resolved.projectId,
    selfSession: process.env.KORTIX_SESSION_ID?.trim() || null,
    participant: null,
  };

  try {
    switch (sub) {
      case 'ls':
      case 'list':
        return await listRooms(ctx, flags);
      case 'create':
        return await createRoom(ctx, rest[0], flags);
      case 'join':
        return await joinRoom(ctx, rest[0], flags);
      case 'people':
        return await listPeople(ctx, rest.join(' '), flags);
      case 'peers':
        return await listPeers(ctx, flags);
      case 'topic':
        return await setTopic(ctx, rest[0], rest[1], flags);
      default: {
        if (!rest[0]) return missing('a room name or id');
        const room = await resolveRoom(ctx, rest[0], flags);
        if (!room) return roomNotFound(rest[0], ctx);
        switch (sub) {
          case 'info':
            return await roomInfo(ctx, room, flags);
          case 'leave':
            return await leaveRoom(ctx, room, flags);
          case 'send':
            return await sendMessage(ctx, room, rest.slice(1), flags);
          case 'read':
            return await readMessages(ctx, room, flags);
          case 'next':
            return await nextMessage(ctx, room, flags);
          case 'watch':
            return await watchRoom(ctx, room, flags);
          case 'chat':
            return await chatRoom(ctx, room);
          case 'archive':
            return await archiveRoom(ctx, room, flags);
          case 'notify-idle':
            return await notifyWhenIdle(ctx, room, rest[1], flags);
        }
        return 2;
      }
    }
  } catch (err) {
    return surfaceApiError(err);
  }
}

/** `kortix peers` is `kortix rooms peers`. */
export function runPeers(argv: string[]): Promise<number> {
  return runRooms(['peers', ...argv]);
}


function roomNotFound(name: string, ctx: Ctx): number {
  process.stderr.write(
    `${status.err(`No conversation "${name}" in project ${shortId(ctx.projectId)}.`)}\n` +
      `  ${C.dim}Create a room: ${C.reset}${C.cyan}kortix rooms join ${name}${C.reset}${C.dim}, or list yours: ${C.reset}${C.cyan}kortix rooms ls --mine${C.reset}\n`,
  );
  return 1;
}

/** The person behind the credential (null for a session's own token use). */
async function myUserId(ctx: Ctx): Promise<string | null> {
  if (ctx.me !== undefined) return ctx.me;
  try {
    ctx.me = (await ctx.client.get<{ user_id?: string }>('/accounts/me')).user_id ?? null;
  } catch {
    ctx.me = null;
  }
  return ctx.me;
}

async function selfIdentity(ctx: Ctx): Promise<Self> {
  if (ctx.selfSession) return { sessionId: ctx.selfSession, userId: null };
  return { sessionId: null, userId: await myUserId(ctx) };
}

/** Where a conversation's messages live for this caller. */
function messagesPath(ctx: Ctx, room: Room): string {
  return ctx.participant
    ? `/projects/${ctx.participant.projectId}/sessions/${ctx.participant.sessionId}/rooms/${room.room_id}/messages`
    : `/projects/${ctx.projectId}/rooms/${room.room_id}/messages`;
}

/**
 * A conversation by room name or id. Inside a session the session's own
 * conversations come first: a room in ANOTHER project is reachable only
 * through the membership (the session's token is bound to its own project).
 */
async function resolveRoom(ctx: Ctx, ref: string, flags: Flags): Promise<Room | null> {
  const ownProject = process.env.KORTIX_PROJECT_ID?.trim();
  if (ctx.selfSession && ownProject) {
    try {
      const { rooms } = await ctx.client.get<{ rooms: Room[] }>(`/projects/${ownProject}/sessions/${ctx.selfSession}/rooms`);
      const named = rooms.filter((room) => room.room_id === ref || room.name === ref);
      const pick = named.find((room) => room.project_id === ctx.projectId) ?? (flags.projectArg ? undefined : named[0]);
      if (pick) {
        ctx.projectId = pick.project_id;
        ctx.participant = { projectId: ownProject, sessionId: ctx.selfSession };
        return pick;
      }
    } catch (err) {
      // An API without rooms, or the flag off in the session's own project:
      // fall through to the project lookup, which reports it properly.
      if (!(err instanceof ApiError)) throw err;
    }
  }
  if (UUID.test(ref)) {
    try {
      return await ctx.client.get<Room>(`/projects/${ctx.projectId}/rooms/${ref}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    }
  }
  const { rooms } = await ctx.client.get<{ rooms: Room[] }>(
    `/projects/${ctx.projectId}/rooms?name=${encodeURIComponent(ref)}&archived=true`,
  );
  return rooms[0] ?? null;
}

async function listRooms(ctx: Ctx, flags: Flags): Promise<number> {
  const query = flags.mine ? '?mine=true' : flags.archived ? '?archived=true' : '';
  const { rooms } = await ctx.client.get<{ rooms: Room[] }>(`/projects/${ctx.projectId}/rooms${query}`);
  if (flags.json) {
    emitJson({ rooms });
    return 0;
  }
  if (rooms.length === 0) {
    process.stdout.write(
      flags.mine
        ? `${C.dim}You are in no room yet. Join one: ${C.reset}${C.cyan}kortix rooms join <room>${C.reset}\n`
        : `${C.dim}No rooms yet. Start one: ${C.reset}${C.cyan}kortix rooms join <room>${C.reset}\n`,
    );
    return 0;
  }
  if (flags.mine) {
    process.stdout.write(`\n  ${C.dim}${pad('CONVERSATION', 34)} ${pad('UNREAD', 7)} ${pad('MESSAGES', 9)} ID${C.reset}\n`);
    for (const room of rooms) {
      const unread = room.unread ? `${C.yellow}${pad(String(room.unread), 7)}${C.reset}` : pad('-', 7);
      process.stdout.write(`  ${C.bold}${pad(roomTitle(room), 34)}${C.reset} ${unread} ${pad(String(room.last_seq), 9)} ${C.faded}${room.room_id}${C.reset}\n`);
    }
    process.stdout.write('\n');
    return 0;
  }
  process.stdout.write(`\n  ${C.dim}${pad('ROOM', 24)} ${pad('MEMBERS', 8)} ${pad('MESSAGES', 9)} TOPIC${C.reset}\n`);
  for (const room of rooms) {
    const name = room.archived_at ? `${room.name} (archived)` : room.name ?? '';
    process.stdout.write(
      `  ${C.bold}${pad(name, 24)}${C.reset} ${pad(String(room.member_count ?? 0), 8)} ${pad(String(room.last_seq), 9)} ${C.dim}${room.topic ?? ''}${C.reset}\n`,
    );
  }
  process.stdout.write('\n');
  return 0;
}

async function createRoom(ctx: Ctx, name: string | undefined, flags: Flags): Promise<number> {
  if (!name) return missing('a room name');
  const room = await ctx.client.post<Room>(`/projects/${ctx.projectId}/rooms`, { name, topic: flags.topic ?? null });
  if (flags.json) emitJson(room);
  else process.stdout.write(`${status.ok(`Room ${C.bold}${room.name}${C.reset} ready`)} ${C.dim}(${shortId(room.room_id)})${C.reset}\n`);
  return 0;
}

/** A person by email or user id, resolved against the people of the project. */
async function resolvePerson(ctx: Ctx, who: string): Promise<{ user_id: string; label: string } | null> {
  if (UUID.test(who)) return { user_id: who, label: who };
  const { people } = await ctx.client.get<{ people: { user_id: string; name: string | null; email: string | null }[] }>(
    `/projects/${ctx.projectId}/rooms/people?q=${encodeURIComponent(who)}`,
  );
  const exact = people.find((p) => p.email?.toLowerCase() === who.toLowerCase());
  const pick = exact ?? (people.length === 1 ? people[0] : undefined);
  return pick ? { user_id: pick.user_id, label: pick.name ?? pick.email ?? pick.user_id } : null;
}

/** Who a membership command acts on: --session, --person, else this session, else you. */
async function memberTarget(ctx: Ctx, flags: Flags): Promise<{ kind: 'session' | 'person'; id: string; label: string } | number> {
  if (flags.session) return { kind: 'session', id: flags.session, label: `Session ${shortId(flags.session)}` };
  if (flags.person) {
    const person = await resolvePerson(ctx, flags.person);
    if (!person) return fail(`No person with access to this project matches "${flags.person}". List them: kortix rooms people`);
    return { kind: 'person', id: person.user_id, label: person.label };
  }
  if (ctx.selfSession) return { kind: 'session', id: ctx.selfSession, label: 'This session' };
  const me = await myUserId(ctx);
  if (!me) return fail('Could not tell who you are; pass --session <id> or --person <email>.');
  return { kind: 'person', id: me, label: 'You' };
}

async function joinRoom(ctx: Ctx, name: string | undefined, flags: Flags): Promise<number> {
  if (!name) return missing('a room name');
  const target = await memberTarget(ctx, flags);
  if (typeof target === 'number') return target;
  let room = await resolveRoom(ctx, name, flags);
  let created = false;
  if (!room) {
    if (UUID.test(name)) return roomNotFound(name, ctx);
    room = await ctx.client.post<Room>(`/projects/${ctx.projectId}/rooms`, { name, topic: flags.topic ?? null });
    created = true;
  }
  const path = target.kind === 'session' ? 'sessions' : 'people';
  const member = await ctx.client.put<RoomMember>(
    `/projects/${ctx.projectId}/rooms/${room.room_id}/members/${path}/${encodeURIComponent(target.id)}`,
    flags.notify ? { notify: flags.notify } : {},
  );
  if (flags.json) {
    emitJson({ room, member, created });
    return 0;
  }
  const how = target.kind === 'session'
    ? `Messages from others arrive as room events; reply with \`kortix rooms send ${room.name} "…"\`.`
    : `Messages from others show as unread (\`kortix rooms ls --mine\`) and notify you when the notification center is on.`;
  process.stdout.write(
    `${status.ok(`${target.label} joined ${C.bold}${roomTitle(room)}${C.reset}${created ? ' (new room)' : ''}`)} ${C.dim}notify=${member.notify}. ${how}${C.reset}\n`,
  );
  return 0;
}

async function leaveRoom(ctx: Ctx, room: Room, flags: Flags): Promise<number> {
  const target = await memberTarget(ctx, flags);
  if (typeof target === 'number') return target;
  const path = target.kind === 'session' && ctx.participant && target.id === ctx.participant.sessionId
    ? `/projects/${ctx.participant.projectId}/sessions/${target.id}/rooms/${room.room_id}`
    : `/projects/${ctx.projectId}/rooms/${room.room_id}/members/${target.kind === 'session' ? 'sessions' : 'people'}/${encodeURIComponent(target.id)}`;
  const result = await ctx.client.delete<{ removed: boolean }>(path);
  if (flags.json) emitJson(result);
  else if (result.removed) process.stdout.write(`${status.ok(`${target.label} left ${C.bold}${roomTitle(room)}${C.reset}`)}\n`);
  else process.stdout.write(`${status.info(`${target.label} was not in ${roomTitle(room)}.`)}\n`);
  return 0;
}

async function roomInfo(ctx: Ctx, room: Room, flags: Flags): Promise<number> {
  const detail = await ctx.client.get<Room & { members: RoomMember[] }>(`/projects/${ctx.projectId}/rooms/${room.room_id}`);
  if (flags.json) {
    emitJson(detail);
    return 0;
  }
  process.stdout.write(
    `\n  ${C.bold}${roomTitle(detail)}${C.reset}${detail.archived_at ? ` ${C.yellow}(archived)${C.reset}` : ''}  ${C.dim}${detail.room_id} · ${detail.last_seq} messages${C.reset}\n` +
      (detail.topic ? `  ${detail.topic}\n` : ''),
  );
  if (detail.members.length === 0) {
    process.stdout.write(`  ${C.dim}No members. Add one: kortix rooms join ${detail.name ?? detail.room_id} --session <id> | --person <email>${C.reset}\n\n`);
    return 0;
  }
  const me = await selfIdentity(ctx);
  process.stdout.write(`\n  ${C.dim}${pad('KIND', 8)} ${pad('MEMBER', 44)} ${pad('NOTIFY', 9)} STATUS${C.reset}\n`);
  for (const member of detail.members) {
    const self = (member.session_id && member.session_id === me.sessionId) || (member.user_id && member.user_id === me.userId)
      ? ` ${C.faded}(you)${C.reset}` : '';
    process.stdout.write(`  ${pad(member.kind, 8)} ${pad(member.label, 44)} ${pad(member.notify, 9)} ${member.status ?? ''}${self}\n`);
  }
  process.stdout.write('\n');
  return 0;
}

async function listPeople(ctx: Ctx, query: string, flags: Flags): Promise<number> {
  const { people } = await ctx.client.get<{ people: { user_id: string; name: string | null; email: string | null }[] }>(
    `/projects/${ctx.projectId}/rooms/people${query ? `?q=${encodeURIComponent(query)}` : ''}`,
  );
  if (flags.json) {
    emitJson({ people });
    return 0;
  }
  if (people.length === 0) {
    process.stdout.write(`${C.dim}Nobody matches.${C.reset}\n`);
    return 0;
  }
  process.stdout.write(`\n  ${C.dim}${pad('NAME', 28)} ${pad('EMAIL', 36)} USER ID${C.reset}\n`);
  for (const person of people) {
    process.stdout.write(`  ${pad(person.name ?? '-', 28)} ${pad(person.email ?? '-', 36)} ${C.faded}${person.user_id}${C.reset}\n`);
  }
  process.stdout.write('\n');
  return 0;
}

/** A session of the project by full id, or by an 8+ character prefix of one of its newest 200 sessions. */
async function resolveSessionId(ctx: Ctx, ref: string): Promise<string | null> {
  if (UUID.test(ref)) return ref;
  if (!/^[0-9a-f-]{8,}$/i.test(ref)) return null;
  const sessions = await ctx.client.get<ProjectSession[]>(`/projects/${ctx.projectId}/sessions?limit=200`);
  const matches = sessions.filter((s) => s.session_id.startsWith(ref.toLowerCase()));
  return matches.length === 1 ? matches[0]!.session_id : null;
}

async function notifyWhenIdle(ctx: Ctx, room: Room, who: string | undefined, flags: Flags): Promise<number> {
  if (!who) return missing('the session to watch: its id or an 8+ char prefix');
  const sessionId = await resolveSessionId(ctx, who);
  if (!sessionId) return fail(`"${who}" is not a session of this project.`);
  const watch = await ctx.client.post<{ watch_id: string | null; fired_now: boolean; expires_at: string }>(
    `/projects/${ctx.projectId}/sessions/${sessionId}/idle-notice`,
    { room: room.room_id },
  );
  if (flags.json) emitJson({ ...watch, room_id: room.room_id });
  else if (watch.fired_now) {
    process.stdout.write(`${status.ok(`Session ${shortId(sessionId)} is idle now; its notice is in ${C.bold}${roomTitle(room)}${C.reset}`)}\n`);
  } else {
    process.stdout.write(
      `${status.ok(`Session ${shortId(sessionId)} posts in ${C.bold}${roomTitle(room)}${C.reset} when its turn ends`)} ${C.dim}(expires ${new Date(watch.expires_at).toLocaleString()})${C.reset}\n`,
    );
  }
  return 0;
}

async function listPeers(ctx: Ctx, flags: Flags): Promise<number> {
  const [sessions, people] = await Promise.all([
    ctx.client.get<ProjectSession[]>(`/projects/${ctx.projectId}/sessions?limit=50`),
    ctx.client.get<{ people: { user_id: string; name: string | null; email: string | null }[] }>(`/projects/${ctx.projectId}/rooms/people`)
      .then((r) => r.people)
      .catch((err) => {
        // Listing people needs project.members.read; sessions stay listable without it.
        if (err instanceof ApiError && err.status === 403) return null;
        throw err;
      }),
  ]);
  const me = await selfIdentity(ctx);
  const others = sessions.filter((s) => s.session_id !== me.sessionId);
  if (flags.json) {
    emitJson({
      self: me,
      sessions: others.map((s) => ({ session_id: s.session_id, name: s.name ?? null, agent: s.agent_name ?? null, status: s.status })),
      people,
    });
    return 0;
  }
  if (me.sessionId) process.stdout.write(`\n  ${C.dim}You are session ${shortId(me.sessionId)}.${C.reset}\n`);
  process.stdout.write(`\n  ${C.dim}${pad('SESSION', 10)} ${pad('STATUS', 10)} ${pad('AGENT', 14)} NAME${C.reset}\n`);
  for (const s of others) {
    process.stdout.write(`  ${pad(shortId(s.session_id), 10)} ${pad(s.status, 10)} ${pad(s.agent_name ?? '-', 14)} ${s.name ?? ''}\n`);
  }
  if (people) {
    process.stdout.write(`\n  ${C.dim}${pad('PERSON', 28)} EMAIL${C.reset}\n`);
    for (const p of people) process.stdout.write(`  ${pad(p.name ?? '-', 28)} ${p.email ?? '-'}\n`);
  } else {
    process.stdout.write(`\n  ${C.dim}People: hidden (needs project.members.read).${C.reset}\n`);
  }
  process.stdout.write(`\n  ${C.dim}Mention one in a room: kortix rooms send <room> "@<session id 8+ chars | email> …"${C.reset}\n\n`);
  return 0;
}

async function readStdinText(): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of process.stdin) chunks.push(String(chunk));
  return chunks.join('').replace(/\n$/, '');
}

function parseTimeout(raw: string | undefined): number | null {
  if (raw === undefined) return 300_000;
  const seconds = Number(raw.replace(/s$/, ''));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

/** Move a person's read cursor; a session has none, and a non-member gets a harmless 404. */
async function markRead(ctx: Ctx, room: Room, seq: number): Promise<void> {
  if (ctx.selfSession || seq <= 0) return;
  try {
    await ctx.client.post(`/projects/${ctx.projectId}/rooms/${room.room_id}/read`, { seq });
  } catch {
    /* not a member: nothing to mark */
  }
}

async function sendMessage(ctx: Ctx, room: Room, args: string[], flags: Flags): Promise<number> {
  let text = args.join(' ');
  if (!text && process.stdin.isTTY !== true) text = await readStdinText();
  if (!text.trim()) return missing('the message text (or pipe it on stdin)');
  let replyTo: number | null = null;
  if (flags.replyTo !== undefined) {
    replyTo = Number(flags.replyTo.replace(/^#/, ''));
    if (!Number.isInteger(replyTo) || replyTo < 1) return fail('--reply-to takes a message seq, e.g. --reply-to 42.');
  }
  const timeoutMs = parseTimeout(flags.timeout);
  if (timeoutMs === null) return fail('--timeout takes seconds, e.g. --timeout 120.');
  const result = await ctx.client.post<PostResult>(messagesPath(ctx, room), { text, reply_to: replyTo });
  const reached = result.deliveries.filter((d) => d.state !== 'skipped').length;
  if (!flags.awaitReply) {
    if (flags.json) emitJson(result);
    else {
      process.stdout.write(
        `${status.ok(`Posted ${C.bold}#${result.message.seq}${C.reset} to ${roomTitle(room)}`)} ${C.dim}— reached ${reached} member${reached === 1 ? '' : 's'}${C.reset}\n`,
      );
      if (result.paused) {
        process.stdout.write(
          `${status.warn('Agents posted the last 20 messages without a person; this one reached no session. A person posting resumes delivery.')}\n`,
        );
      }
    }
    return 0;
  }
  if (!flags.json) process.stderr.write(`${C.dim}Posted #${result.message.seq}; waiting up to ${Math.round(timeoutMs / 1000)}s for a reply…${C.reset}\n`);
  const self = await selfIdentity(ctx);
  const reply = await waitFor(ctx, room, result.message.seq, timeoutMs, (messages) => pickReply(messages, result.message.seq, self));
  if (!reply) {
    if (flags.json) emitJson({ ...result, reply: null });
    else process.stderr.write(`${status.err(`No reply in ${Math.round(timeoutMs / 1000)}s.`)}\n`);
    return 4;
  }
  await markRead(ctx, room, reply.seq);
  if (flags.json) emitJson({ ...result, reply });
  else process.stdout.write(`${formatMessage(reply)}\n`);
  return 0;
}

/** Poll forward from `afterSeq` until `pick` returns a message or `timeoutMs` passes. */
async function waitFor(
  ctx: Ctx,
  room: Room,
  afterSeq: number,
  timeoutMs: number,
  pick: (messages: RoomMessage[]) => RoomMessage | null,
): Promise<RoomMessage | null> {
  const deadline = Date.now() + timeoutMs;
  let cursor = afterSeq;
  const seen: RoomMessage[] = [];
  while (Date.now() < deadline) {
    const page = await ctx.client.get<{ messages: RoomMessage[] }>(`${messagesPath(ctx, room)}?after=${cursor}&limit=200`);
    seen.push(...page.messages);
    const found = pick(seen);
    if (found) return found;
    cursor = page.messages.at(-1)?.seq ?? cursor;
    await sleep(Math.min(POLL_MS, Math.max(0, deadline - Date.now())));
  }
  return null;
}

async function readMessages(ctx: Ctx, room: Room, flags: Flags): Promise<number> {
  const limit = flags.limit === undefined ? 20 : Number(flags.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) return fail('--limit takes 1..200.');
  const query = new URLSearchParams({ limit: String(limit) });
  if (flags.after !== undefined) query.set('after', flags.after.replace(/^#/, ''));
  if (flags.thread !== undefined) {
    const root = Number(flags.thread.replace(/^#/, ''));
    if (!Number.isInteger(root) || root < 1) return fail('--thread takes a message seq, e.g. --thread 42.');
    query.set('thread', String(root));
  }
  const page = await ctx.client.get<{ messages: RoomMessage[]; last_seq: number }>(`${messagesPath(ctx, room)}?${query}`);
  await markRead(ctx, room, page.messages.at(-1)?.seq ?? 0);
  if (flags.json) {
    emitJson({ room: { room_id: room.room_id, name: room.name, project_id: room.project_id }, ...page });
    return 0;
  }
  if (page.messages.length === 0) {
    process.stdout.write(`${C.dim}No messages${flags.after ? ` after #${flags.after}` : ''} in ${roomTitle(room)}.${C.reset}\n`);
    return 0;
  }
  const self = await selfIdentity(ctx);
  for (const message of page.messages) process.stdout.write(`${formatMessage(message, isOwnMessage(message, self))}\n`);
  return 0;
}

async function nextMessage(ctx: Ctx, room: Room, flags: Flags): Promise<number> {
  const timeoutMs = parseTimeout(flags.timeout);
  if (timeoutMs === null) return fail('--timeout takes seconds, e.g. --timeout 120.');
  const after = flags.after === undefined ? room.last_seq : Number(flags.after.replace(/^#/, ''));
  if (!Number.isInteger(after) || after < 0) return fail('--after takes a message seq.');
  const self = await selfIdentity(ctx);
  const message = await waitFor(ctx, room, after, timeoutMs, (messages) => messages.find((m) => !isOwnMessage(m, self)) ?? null);
  if (!message) {
    if (flags.json) emitJson({ message: null });
    else process.stderr.write(`${status.err(`Nothing new in ${roomTitle(room)} in ${Math.round(timeoutMs / 1000)}s.`)}\n`);
    return 4;
  }
  await markRead(ctx, room, message.seq);
  if (flags.json) emitJson({ message });
  else process.stdout.write(`${formatMessage(message)}\n`);
  return 0;
}

/** Print every message after `cursor` as it arrives; never returns on its own. */
async function tail(ctx: Ctx, room: Room, cursor: number, print: (message: RoomMessage) => void): Promise<never> {
  for (;;) {
    try {
      const page = await ctx.client.get<{ messages: RoomMessage[] }>(`${messagesPath(ctx, room)}?after=${cursor}&limit=200`);
      for (const message of page.messages) print(message);
      cursor = page.messages.at(-1)?.seq ?? cursor;
      if (page.messages.length > 0) await markRead(ctx, room, cursor);
    } catch (err) {
      if (!(err instanceof ApiError) || err.status < 500) throw err;
      // A 5xx is transient; keep tailing.
    }
    await sleep(POLL_MS);
  }
}

async function watchRoom(ctx: Ctx, room: Room, flags: Flags): Promise<number> {
  const after = flags.after === undefined ? room.last_seq : Number(flags.after.replace(/^#/, ''));
  if (!Number.isInteger(after) || after < 0) return fail('--after takes a message seq.');
  const self = await selfIdentity(ctx);
  if (!flags.json) process.stderr.write(`${C.dim}Watching ${roomTitle(room)} from #${after}. Ctrl+C stops.${C.reset}\n`);
  return tail(ctx, room, after, (message) => {
    process.stdout.write(flags.json ? `${JSON.stringify(message)}\n` : `${formatMessage(message, isOwnMessage(message, self))}\n`);
  });
}

async function chatRoom(ctx: Ctx, room: Room): Promise<number> {
  const self = await selfIdentity(ctx);
  const recent = await ctx.client.get<{ messages: RoomMessage[]; last_seq: number }>(`${messagesPath(ctx, room)}?limit=20`);
  await markRead(ctx, room, recent.last_seq);
  process.stdout.write(`\n${C.dim}Conversation ${C.reset}${C.bold}${roomTitle(room)}${C.reset}${room.topic ? ` ${C.dim}— ${room.topic}${C.reset}` : ''}\n`);
  process.stdout.write(`${C.dim}Type a message and press Enter. /reply <seq> <text> threads a reply. Ctrl-D or /exit quits.${C.reset}\n\n`);
  for (const message of recent.messages) process.stdout.write(`${formatMessage(message, isOwnMessage(message, self))}\n`);
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: `${C.green}${C.bold}›${C.reset} ` });
  rl.prompt();
  const printed = new Set<number>(recent.messages.map((message) => message.seq));
  void tail(ctx, room, recent.last_seq, (message) => {
    if (printed.has(message.seq)) return;
    printed.add(message.seq);
    process.stdout.write(`\r\x1b[K${formatMessage(message, isOwnMessage(message, self))}\n`);
    rl.prompt(true);
  }).catch((err) => {
    surfaceApiError(err);
    rl.close();
  });
  return new Promise((resolve) => {
    rl.on('line', async (line) => {
      const input = line.trim();
      if (input === '/exit' || input === '/quit') return rl.close();
      if (!input) return rl.prompt();
      const reply = /^\/reply\s+#?(\d+)\s+([\s\S]+)$/.exec(input);
      try {
        const result = await ctx.client.post<PostResult>(messagesPath(ctx, room), {
          text: reply ? reply[2] : input,
          reply_to: reply ? Number(reply[1]) : null,
        });
        printed.add(result.message.seq);
        process.stdout.write(`\x1b[1A\r\x1b[K${formatMessage(result.message, true)}\n`);
        if (result.paused) process.stdout.write(`${status.warn('Delivery to sessions is paused until a person posts.')}\n`);
      } catch (err) {
        surfaceApiError(err);
      }
      rl.prompt();
    });
    rl.on('close', () => {
      process.stdout.write(`${C.dim}bye.${C.reset}\n`);
      resolve(0);
    });
  });
}

async function setTopic(ctx: Ctx, name: string | undefined, topic: string | undefined, flags: Flags): Promise<number> {
  if (!name) return missing('a room name');
  if (topic === undefined) return missing('the topic text ("" clears it)');
  const room = await resolveRoom(ctx, name, flags);
  if (!room) return roomNotFound(name, ctx);
  const updated = await ctx.client.patch<Room>(`/projects/${ctx.projectId}/rooms/${room.room_id}`, { topic: topic || null });
  if (flags.json) emitJson(updated);
  else process.stdout.write(`${status.ok(`Topic of ${C.bold}${roomTitle(updated)}${C.reset} ${updated.topic ? `set: ${updated.topic}` : 'cleared'}`)}\n`);
  return 0;
}

async function archiveRoom(ctx: Ctx, room: Room, flags: Flags): Promise<number> {
  const updated = await ctx.client.patch<Room>(`/projects/${ctx.projectId}/rooms/${room.room_id}`, { archived: !flags.undo });
  if (flags.json) emitJson(updated);
  else process.stdout.write(`${status.ok(`${roomTitle(updated)} ${updated.archived_at ? 'archived' : 'unarchived'}`)}\n`);
  return 0;
}
