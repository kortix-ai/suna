/**
 * A command button's data (`kc:`), without the database graph of commands.ts.
 * The token names a command and, at most, a page or a pick: never a chat, a
 * project or a person. A press runs in the pressed message's chat, so a forged
 * or forwarded token can do nothing that typing the command there cannot.
 */
import { createHash } from 'node:crypto';
import { CHANNEL_COMMANDS, type ChannelCommandName } from './command-list';

/** What one button runs. Persisted in chats through `pressData`: never change the format. */
export interface CommandPress {
  name: ChannelCommandName;
  /** A list's page, 0-based (model, agent). */
  page?: number;
  /** model and agent: `choiceRef` of the option. stop: the session the button stops. */
  pick?: string;
}

/**
 * At most 62 bytes with a command name of CHANNEL_COMMANDS: under Telegram's 64
 * (`CHANNELS.telegram.buttons.dataBytes`). A page has up to 3 digits: 1,000 pages.
 */
const PRESS = /^kc:([a-z]{1,16})(?::(?:p(\d{1,3})|=([A-Za-z0-9_-]{1,51})))?$/;

/** Null: not a well-formed Kortix command token. A `kc:` token that is null is a stale or forged one. */
export function parsePressData(data: string): CommandPress | null {
  const match = PRESS.exec(data);
  const spec = match && CHANNEL_COMMANDS.find((c) => c.name === match[1]);
  if (!spec) return null;
  return { name: spec.name, ...(match[2] ? { page: Number(match[2]) } : {}), ...(match[3] ? { pick: match[3] } : {}) };
}

/**
 * `kc:<name>`, `kc:<name>:p<page>` or `kc:<name>:=<pick>`, ASCII. The longest Kortix
 * posts is `kc:stop:=<uuid>`, 45 bytes. Throws for a press that would not parse back
 * (a page over 999, a pick over 51 characters or outside base64url): a bug.
 */
export function pressData(p: CommandPress): string {
  const data = `kc:${p.name}${p.page !== undefined ? `:p${p.page}` : p.pick !== undefined ? `:=${p.pick}` : ''}`;
  if (!parsePressData(data)) throw new Error(`command press does not fit a button: ${p.name}`);
  return data;
}

/** Whose press it is: `kc:` is a command button, `kq:` a question button (question-token.ts). */
export const isCommandPressData = (data: string): boolean => data.startsWith('kc:');

/** 'd' for the project default; else the first 11 base64url characters (66 bits) of SHA-256(value). */
export function choiceRef(value: string): string {
  return value === 'default' ? 'd' : createHash('sha256').update(value).digest('base64url').slice(0, 11);
}
