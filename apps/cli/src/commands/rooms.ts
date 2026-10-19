/**
 * `kortix rooms` — named rooms where sessions and people message each other.
 *
 * A session JOINS a room; every message another participant posts lands in
 * its prompt inbox (a running turn reads it at its next step, a stopped
 * session wakes). People and scripts post and read here. The server owns
 * delivery, authorization and loop limits (`/projects/:id/rooms`, flag
 * `agent_rooms`); this file is argument parsing, name resolution and output.
 */
import { createInterface } from 'node:readline';
import type { ApiClient } from '../api/client.ts';
import { ApiError } from '../api/client.ts';
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

Rooms are named message logs in a project where agent sessions and people talk
to each other: \`dev\`, \`deploys\`, \`platinum/dev\`. A session that JOINS a room
receives every message another participant posts, in its prompt inbox: a
running turn reads it at its next step, a stopped session wakes to answer.
Replies go back with \`kortix rooms send\`. Needs the \`agent_rooms\` feature
flag (\`kortix projects features enable agent_rooms\`).

Inside a session, <room> commands act as that session ($KORTIX_SESSION_ID).

Subcommands:
  ls                         List the project's rooms. --archived adds archived ones.
  create <room>              Create a room. --topic "<what it is for>".
  info <room>                The room, its topic and the sessions in it.
  join <room>                Put a session in the room (default: this session).
                             Creates the room when it does not exist.
                             --session <id>, --notify all|mentions|none,
                             --topic "<…>" (for a room it creates).
  leave <room>               Take a session out (default: this session).
                             --session <id>.
  send <room> ["<text>"]     Post a message; reads stdin when no text is given.
                             --reply-to <seq>; --await-reply waits until another
                             participant posts and prints that message.
  read <room>                Print messages. --after <seq> reads forward,
                             --limit <n> (default 20, max 200).
  next <room>                Block until another participant posts, print it,
                             exit. --after <seq> (default: now). Exit 4 on
                             --timeout <secs> (default 300).
  watch <room>               Stream new messages until Ctrl+C.
  chat <room>                Interactive: new messages print as they arrive,
                             each line you type is posted.
  topic <room> "<topic>"     Set the topic ("" clears it).
  archive <room>             Archive: keeps the log, takes no new messages.
                             --undo unarchives. Creator or project.write.

Delivery (join --notify):
  all        every message from someone else (default)
  mentions   only messages that @-mention the session: @<8+ chars of its id>,
             @<agent name>, @<session name>, or @all
  none       nothing; read the room yourself

Limits: 16,000 characters per message, 30 messages per minute per sender per
room. After 20 consecutive messages from sessions, a session's message reaches
no other session until a person posts.

Options:
  --project <id>     Project of the room (default: linked).
  --host <name>      Operate against a non-default Kortix host.
  --json             Machine-readable output.
  -h, --help         Show this help.

Exit codes: 0 ok, 1 API error, 2 usage error, 4 timed out (next, --await-reply).

Examples:
  kortix rooms join dev --topic "dev deploys and who is touching dev"
  kortix rooms send dev "I am re-running deploy-dev; hold merges for 10 min"
  kortix rooms send platinum/dev "@3f2a1b9c did you block dev?" --await-reply
  kortix rooms next dev --timeout 120
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
  session_id: string;
  project_id: string;
  notify: string;
  agent_name: string | null;
  session_name: string | null;
  status: string | null;
}

interface PostResult {
  message: RoomMessage;
  deliveries: { session_id: string; state: 'queued' | 'skipped'; reason?: string }[];
  paused: boolean;
}

interface Flags {
  json: boolean;
  projectArg?: string;
  hostArg?: string;
  topic?: string;
  session?: string;
  notify?: string;
  replyTo?: string;
  after?: string;
  limit?: string;
  timeout?: string;
  awaitReply: boolean;
  archived: boolean;
  undo: boolean;
}

interface Ctx {
  client: ApiClient;
  projectId: string;
  /** The session this CLI runs in, when it runs inside one. */
  selfSession: string | null;
  /** Set when the room was found through this session's own memberships:
   *  messages and leave then go through the session's routes under its own
   *  project, the only path to a room in another project. */
  participant: { projectId: string; sessionId: string } | null;
}

/** Where a room's messages live for this caller. */
function messagesPath(ctx: Ctx, room: Room): string {
  return ctx.participant
    ? `/projects/${ctx.participant.projectId}/sessions/${ctx.participant.sessionId}/rooms/${room.room_id}/messages`
    : `/projects/${ctx.projectId}/rooms/${room.room_id}/messages`;
}

const POLL_MS = 2_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
export function isOwnMessage(message: RoomMessage, self: { sessionId: string | null; userId: string | null }): boolean {
  if (self.sessionId) return message.sender_session_id === self.sessionId;
  return message.sender_kind === 'member' && !!self.userId && message.sender_user_id === self.userId;
}

/** The message `send --await-reply` returns: one that replies to `seq`, else the first from someone else. */
export function pickReply(messages: RoomMessage[], seq: number, self: { sessionId: string | null; userId: string | null }): RoomMessage | null {
  const others = messages.filter((message) => message.seq > seq && !isOwnMessage(message, self));
  return others.find((message) => message.reply_to_seq === seq) ?? others[0] ?? null;
}

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
      notify: takeFlagValue(rest, ['--notify']),
      replyTo: takeFlagValue(rest, ['--reply-to']),
      after: takeFlagValue(rest, ['--after']),
      limit: takeFlagValue(rest, ['--limit']),
      timeout: takeFlagValue(rest, ['--timeout']),
      awaitReply: takeFlagBool(rest, ['--await-reply']),
      archived: takeFlagBool(rest, ['--archived']),
      undo: takeFlagBool(rest, ['--undo']),
    };
  } catch (err) {
    return fail((err as Error).message);
  }
  const unknown = rest.find((arg) => arg.startsWith('-') && arg !== '-');
  if (unknown) return fail(`unknown option "${unknown}". Run \`kortix rooms --help\`.`);
  if (flags.notify && !['all', 'mentions', 'none'].includes(flags.notify)) {
    return fail('--notify must be all, mentions or none.');
  }

  const known = ['ls', 'list', 'create', 'info', 'join', 'leave', 'send', 'read', 'next', 'watch', 'chat', 'topic', 'archive'];
  if (!known.includes(sub)) return fail(`unknown subcommand "${sub}". Run \`kortix rooms --help\`.`);

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
      case 'topic':
        return await setTopic(ctx, rest[0], rest[1], flags);
      default: {
        if (!rest[0]) return missing('a room name');
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
        }
        return 2;
      }
    }
  } catch (err) {
    return surfaceApiError(err);
  }
}

function roomNotFound(name: string, ctx: Ctx): number {
  process.stderr.write(
    `${status.err(`No room "${name}" in project ${shortId(ctx.projectId)}.`)}\n` +
      `  ${C.dim}Create it: ${C.reset}${C.cyan}kortix rooms create ${name}${C.reset}${C.dim}, or join it: ${C.reset}${C.cyan}kortix rooms join ${name}${C.reset}\n`,
  );
  return 1;
}

const isUuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

/**
 * A room by name or id. Inside a session the session's own rooms come first:
 * a room in ANOTHER project is reachable only through the membership (the
 * session's token is bound to its own project), and its name is unique per
 * project, so `--project` picks among same-named rooms.
 */
async function resolveRoom(ctx: Ctx, ref: string, flags: Flags): Promise<Room | null> {
  if (isUuid(ref)) return ctx.client.get<Room>(`/projects/${ctx.projectId}/rooms/${ref}`);
  const ownProject = process.env.KORTIX_PROJECT_ID?.trim();
  if (ctx.selfSession && ownProject) {
    try {
      const { rooms } = await ctx.client.get<{ rooms: Room[] }>(`/projects/${ownProject}/sessions/${ctx.selfSession}/rooms`);
      const named = rooms.filter((room) => room.name === ref);
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
  const { rooms } = await ctx.client.get<{ rooms: Room[] }>(
    `/projects/${ctx.projectId}/rooms?name=${encodeURIComponent(ref)}&archived=true`,
  );
  return rooms[0] ?? null;
}

async function listRooms(ctx: Ctx, flags: Flags): Promise<number> {
  const { rooms } = await ctx.client.get<{ rooms: Room[] }>(
    `/projects/${ctx.projectId}/rooms${flags.archived ? '?archived=true' : ''}`,
  );
  if (flags.json) {
    emitJson({ rooms });
    return 0;
  }
  if (rooms.length === 0) {
    process.stdout.write(`${C.dim}No rooms yet. Start one: ${C.reset}${C.cyan}kortix rooms join <room>${C.reset}\n`);
    return 0;
  }
  process.stdout.write(`\n  ${C.dim}${pad('ROOM', 24)} ${pad('SESSIONS', 9)} ${pad('MESSAGES', 9)} TOPIC${C.reset}\n`);
  for (const room of rooms) {
    const name = room.archived_at ? `${room.name} (archived)` : room.name;
    process.stdout.write(
      `  ${C.bold}${pad(name, 24)}${C.reset} ${pad(String(room.member_count ?? 0), 9)} ${pad(String(room.last_seq), 9)} ${C.dim}${room.topic ?? ''}${C.reset}\n`,
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

async function joinRoom(ctx: Ctx, name: string | undefined, flags: Flags): Promise<number> {
  if (!name) return missing('a room name');
  const sessionId = flags.session ?? ctx.selfSession;
  if (!sessionId) return fail('Pass --session <id>. Inside a session it defaults to $KORTIX_SESSION_ID.');
  let room = await resolveRoom(ctx, name, flags);
  let created = false;
  if (!room) {
    room = await ctx.client.post<Room>(`/projects/${ctx.projectId}/rooms`, { name, topic: flags.topic ?? null });
    created = true;
  }
  const member = await ctx.client.put<RoomMember>(
    `/projects/${ctx.projectId}/rooms/${room.room_id}/members/${encodeURIComponent(sessionId)}`,
    flags.notify ? { notify: flags.notify } : {},
  );
  if (flags.json) {
    emitJson({ room, member, created });
    return 0;
  }
  const who = sessionId === ctx.selfSession ? 'This session' : `Session ${shortId(sessionId)}`;
  process.stdout.write(
    `${status.ok(`${who} joined ${C.bold}${room.name}${C.reset}${created ? ' (new room)' : ''}`)} ${C.dim}notify=${member.notify}. ` +
      `Messages from others arrive in its inbox; reply with \`kortix rooms send ${room.name} "…"\`.${C.reset}\n`,
  );
  return 0;
}

async function leaveRoom(ctx: Ctx, room: Room, flags: Flags): Promise<number> {
  const sessionId = flags.session ?? ctx.selfSession;
  if (!sessionId) return fail('Pass --session <id>. Inside a session it defaults to $KORTIX_SESSION_ID.');
  const result = await ctx.client.delete<{ removed: boolean }>(
    ctx.participant && sessionId === ctx.participant.sessionId
      ? `/projects/${ctx.participant.projectId}/sessions/${sessionId}/rooms/${room.room_id}`
      : `/projects/${ctx.projectId}/rooms/${room.room_id}/members/${encodeURIComponent(sessionId)}`,
  );
  if (flags.json) emitJson(result);
  else if (result.removed) process.stdout.write(`${status.ok(`Session ${shortId(sessionId)} left ${C.bold}${room.name}${C.reset}`)}\n`);
  else process.stdout.write(`${status.info(`Session ${shortId(sessionId)} was not in ${room.name}.`)}\n`);
  return 0;
}

async function roomInfo(ctx: Ctx, room: Room, flags: Flags): Promise<number> {
  const detail = await ctx.client.get<Room & { members: RoomMember[] }>(`/projects/${ctx.projectId}/rooms/${room.room_id}`);
  if (flags.json) {
    emitJson(detail);
    return 0;
  }
  process.stdout.write(
    `\n  ${C.bold}${detail.name}${C.reset}${detail.archived_at ? ` ${C.yellow}(archived)${C.reset}` : ''}  ${C.dim}${detail.room_id} · ${detail.last_seq} messages${C.reset}\n` +
      (detail.topic ? `  ${detail.topic}\n` : ''),
  );
  if (detail.members.length === 0) {
    process.stdout.write(`  ${C.dim}No sessions listen here. Add one: kortix rooms join ${detail.name} --session <id>${C.reset}\n\n`);
    return 0;
  }
  process.stdout.write(`\n  ${C.dim}${pad('SESSION', 10)} ${pad('AGENT', 14)} ${pad('NOTIFY', 9)} ${pad('STATUS', 9)} NAME${C.reset}\n`);
  for (const member of detail.members) {
    const self = member.session_id === ctx.selfSession ? ` ${C.faded}(this session)${C.reset}` : '';
    process.stdout.write(
      `  ${pad(shortId(member.session_id), 10)} ${pad(member.agent_name ?? '-', 14)} ${pad(member.notify, 9)} ${pad(member.status ?? '-', 9)} ${member.session_name ?? ''}${self}\n`,
    );
  }
  process.stdout.write('\n');
  return 0;
}

async function readStdinText(): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of process.stdin) chunks.push(String(chunk));
  return chunks.join('').replace(/\n$/, '');
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
  const result = await ctx.client.post<PostResult>(messagesPath(ctx, room), {
    text,
    reply_to: replyTo,
  });
  const queued = result.deliveries.filter((delivery) => delivery.state === 'queued').length;
  if (!flags.awaitReply) {
    if (flags.json) emitJson(result);
    else {
      process.stdout.write(
        `${status.ok(`Posted ${C.bold}#${result.message.seq}${C.reset} to ${room.name}`)} ${C.dim}— delivered to ${queued} session${queued === 1 ? '' : 's'}${C.reset}\n`,
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
  const self = await selfIdentity(ctx, result.message);
  const reply = await waitFor(ctx, room, result.message.seq, timeoutMs, (messages) => pickReply(messages, result.message.seq, self));
  if (!reply) {
    if (flags.json) emitJson({ ...result, reply: null });
    else process.stderr.write(`${status.err(`No reply in ${Math.round(timeoutMs / 1000)}s.`)}\n`);
    return 4;
  }
  if (flags.json) emitJson({ ...result, reply });
  else process.stdout.write(`${formatMessage(reply)}\n`);
  return 0;
}

/** Who "you" are for filtering: this session, or the person (read off a message you sent, else /accounts/me). */
async function selfIdentity(ctx: Ctx, sent?: RoomMessage): Promise<{ sessionId: string | null; userId: string | null }> {
  if (ctx.selfSession) return { sessionId: ctx.selfSession, userId: null };
  if (sent?.sender_kind === 'member') return { sessionId: null, userId: sent.sender_user_id };
  try {
    const me = await ctx.client.get<{ user_id?: string }>('/accounts/me');
    return { sessionId: null, userId: me.user_id ?? null };
  } catch {
    return { sessionId: null, userId: null };
  }
}

function parseTimeout(raw: string | undefined): number | null {
  if (raw === undefined) return 300_000;
  const seconds = Number(raw.replace(/s$/, ''));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
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
    const page = await ctx.client.get<{ messages: RoomMessage[] }>(
      `${messagesPath(ctx, room)}?after=${cursor}&limit=200`,
    );
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
  const page = await ctx.client.get<{ messages: RoomMessage[]; last_seq: number }>(
    `${messagesPath(ctx, room)}?${query}`,
  );
  if (flags.json) {
    emitJson({ room: { room_id: room.room_id, name: room.name, project_id: room.project_id }, ...page });
    return 0;
  }
  if (page.messages.length === 0) {
    process.stdout.write(`${C.dim}No messages${flags.after ? ` after #${flags.after}` : ''} in ${room.name}.${C.reset}\n`);
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
    else process.stderr.write(`${status.err(`Nothing new in ${room.name} in ${Math.round(timeoutMs / 1000)}s.`)}\n`);
    return 4;
  }
  if (flags.json) emitJson({ message });
  else process.stdout.write(`${formatMessage(message)}\n`);
  return 0;
}

/** Print every message after `cursor` as it arrives; never returns on its own. */
async function tail(ctx: Ctx, room: Room, cursor: number, print: (message: RoomMessage) => void): Promise<never> {
  for (;;) {
    try {
      const page = await ctx.client.get<{ messages: RoomMessage[] }>(
        `${messagesPath(ctx, room)}?after=${cursor}&limit=200`,
      );
      for (const message of page.messages) print(message);
      cursor = page.messages.at(-1)?.seq ?? cursor;
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
  if (!flags.json) process.stderr.write(`${C.dim}Watching ${room.name} from #${after}. Ctrl+C stops.${C.reset}\n`);
  return tail(ctx, room, after, (message) => {
    process.stdout.write(flags.json ? `${JSON.stringify(message)}\n` : `${formatMessage(message, isOwnMessage(message, self))}\n`);
  });
}

async function chatRoom(ctx: Ctx, room: Room): Promise<number> {
  const self = await selfIdentity(ctx);
  const recent = await ctx.client.get<{ messages: RoomMessage[]; last_seq: number }>(
    `${messagesPath(ctx, room)}?limit=20`,
  );
  process.stdout.write(`\n${C.dim}Room ${C.reset}${C.bold}${room.name}${C.reset}${room.topic ? ` ${C.dim}— ${room.topic}${C.reset}` : ''}\n`);
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
  else process.stdout.write(`${status.ok(`Topic of ${C.bold}${updated.name}${C.reset} ${updated.topic ? `set: ${updated.topic}` : 'cleared'}`)}\n`);
  return 0;
}

async function archiveRoom(ctx: Ctx, room: Room, flags: Flags): Promise<number> {
  const updated = await ctx.client.patch<Room>(`/projects/${ctx.projectId}/rooms/${room.room_id}`, { archived: !flags.undo });
  if (flags.json) emitJson(updated);
  else process.stdout.write(`${status.ok(`${updated.name} ${updated.archived_at ? 'archived' : 'unarchived'}`)}\n`);
  return 0;
}
