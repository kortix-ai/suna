/**
 * Minimal Discord REST client for the server side of the channel: the install
 * (the OAuth code exchange, the guild), the slash commands, the replies,
 * threads and typing of the conversation, the agent's questions and the command
 * menus (messages with components, their edits and the interaction follow-ups),
 * the allowed users' names and avatars, and a message's files. Agent-sent
 * messages go through the `kortix_discord` connector instead (connectors/channels.ts).
 *
 * One bot token serves every project: the Kortix Discord application's
 * (config.DISCORD_BOT_TOKEN). Every write names a channel a project's
 * conversation proved, never one a sender typed.
 */
import { config } from '../../config';
import { readCapped } from '../core/download';

export class DiscordApiError extends Error {
  constructor(
    readonly route: string,
    readonly status: number,
    /** Discord's JSON error code (`50001` Missing Access, `10003` Unknown Channel, …); 0 when none. */
    readonly code: number,
    description: string,
  ) {
    // The route template only: a path carries ids, an interaction path a token.
    super(`discord ${route} failed (${status}${code ? `, ${code}` : ''}): ${description}`);
  }
}

export const discordApiBase = () => config.DISCORD_API_URL.replace(/\/+$/, '');

/** The Kortix Discord application is configured on this server. */
export function discordConfigured(): boolean {
  return Boolean(
    config.DISCORD_APPLICATION_ID && config.DISCORD_PUBLIC_KEY && config.DISCORD_CLIENT_SECRET && config.DISCORD_BOT_TOKEN,
  );
}

/** The longest a rate-limited call waits for its bucket before it fails. */
const MAX_RETRY_AFTER_MS = 5_000;

/**
 * One REST call. `route` is the path template for errors and logs
 * (`POST /channels/{id}/messages`); `path` the real path. A 429 waits for
 * `retry_after` once, up to 5 s. `auth: false` for an interaction webhook,
 * which its token authorizes.
 */
export async function discordCall<T = unknown>(
  route: string,
  path: string,
  init: { method?: string; body?: unknown; timeoutMs?: number; auth?: boolean; reason?: string } = {},
): Promise<T> {
  const method = init.method ?? 'GET';
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${discordApiBase()}${path}`, {
        method,
        headers: {
          ...(init.auth === false ? {} : { Authorization: `Bot ${config.DISCORD_BOT_TOKEN}` }),
          ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          'User-Agent': 'DiscordBot (https://kortix.com, 1)',
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        signal: AbortSignal.timeout(init.timeoutMs ?? 10_000),
      });
    } catch (error) {
      throw new DiscordApiError(route, 0, 0, error instanceof Error ? error.name : 'network error');
    }
    if (res.status === 204) return undefined as T;
    const data = (await res.json().catch(() => null)) as (T & { message?: string; code?: number; retry_after?: number }) | null;
    if (res.ok) return data as T;
    const retryAfterMs = Math.ceil((data?.retry_after ?? Number(res.headers.get('retry-after') ?? NaN)) * 1000);
    if (res.status === 429 && attempt === 0 && retryAfterMs >= 0 && retryAfterMs <= MAX_RETRY_AFTER_MS) {
      await new Promise((resolve) => setTimeout(resolve, retryAfterMs));
      continue;
    }
    throw new DiscordApiError(route, res.status, data?.code ?? 0, data?.message ?? 'no response');
  }
}

/** Discord could not answer: no connection, a timeout, a rate limit or a 5xx. Anything else is a refusal. */
export function discordUnreachable(error: unknown): boolean {
  return !(error instanceof DiscordApiError) || error.status === 0 || error.status === 429 || error.status >= 500;
}

/**
 * An attachment's bytes from its CDN URL, at most `maxBytes`. The URL is
 * signed and expires; it never reaches an error or a log.
 */
export async function discordDownload(url: string, maxBytes: number): Promise<Uint8Array<ArrayBuffer> | 'too_large' | 'unavailable'> {
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  } catch (error) {
    throw new DiscordApiError('GET attachment', 0, 0, error instanceof Error ? error.name : 'network error');
  }
  if (res.status === 429 || res.status >= 500) throw new DiscordApiError('GET attachment', res.status, 0, 'unavailable');
  if (!res.ok) return 'unavailable';
  let bytes: Uint8Array<ArrayBuffer> | null;
  try {
    bytes = await readCapped(res, maxBytes);
  } catch (error) {
    throw new DiscordApiError('GET attachment', 0, 0, error instanceof Error ? error.name : 'network error');
  }
  return bytes ?? 'too_large';
}

/** A Discord user, as messages, members and interactions carry it. */
export interface DiscordUser {
  id: string;
  username?: string;
  global_name?: string | null;
  avatar?: string | null;
  bot?: boolean;
}

/** The fields of a channel the adapter reads. */
export interface DiscordChannel {
  id: string;
  /** 0 text, 1 DM, 2 voice, 3 group DM, 5 announcement, 10/11/12 threads, 13 stage, 15 forum, 16 media. */
  type: number;
  guild_id?: string;
  name?: string | null;
  parent_id?: string | null;
}

export const DISCORD_CHANNEL_TYPE = {
  text: 0,
  dm: 1,
  groupDm: 3,
  announcement: 5,
  announcementThread: 10,
  publicThread: 11,
  privateThread: 12,
  forum: 15,
  media: 16,
} as const;

export const isDiscordThread = (type: number) => type === 10 || type === 11 || type === 12;

/**
 * A snowflake's place in time order as a safe integer: its milliseconds since
 * 2015 and its 12-bit increment. The 10 worker and process bits go, so an id
 * fits a JS number (the event inbox's `sequence`) until 2084.
 */
export function snowflakeSequence(id: string): number {
  if (!/^\d{1,20}$/.test(id)) return 0;
  const value = BigInt(id);
  return Number(((value >> 22n) << 12n) | (value & 0xfffn));
}
