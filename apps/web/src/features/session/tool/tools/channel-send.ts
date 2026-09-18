/**
 * Recognise a channel reply the agent sent from its sandbox — `teams send
 * "…"`, `slack send "…"`, `telegram send --text "…"` — inside a bash tool
 * call, so the session view can render it as the outgoing message it is
 * rather than as a shell invocation with a JSON result.
 *
 * The sandbox CLIs (apps/sandbox/slack-cli/channels/*.ts) accept the text as
 * the first positional argument or as `--text`, and a file as `--file`. A
 * `--text-file` body lives on the sandbox disk and is not in the command, so
 * that shape is left to the ordinary command card.
 *
 * Pure and dependency-free; pinned by `channel-send.test.ts`.
 */

import type { ChannelPlatform } from '@/features/session/turn/channel-message';

export interface ChannelSend {
  platform: ChannelPlatform;
  /** The message text, or null for a bare file send. */
  text: string | null;
  /** Basename of a `--file` attachment, when one was sent. */
  file: string | null;
  /** Slack `--channel`, when the send targeted a channel rather than the live turn. */
  channel: string | null;
}

const CLI_PLATFORM: Record<string, ChannelPlatform> = {
  teams: 'Teams',
  slack: 'Slack',
  telegram: 'Telegram',
};

/**
 * Split a POSIX shell command line into words, honouring single quotes,
 * double quotes (with `\"` and `\\` escapes), `$'…'` ANSI-C strings (the
 * common escapes) and backslash-escaped spaces. Good enough for the one-line
 * invocations the agent writes; anything with pipes, subshells or heredocs is
 * refused by the caller before this runs.
 */
export function splitShellWords(line: string): string[] | null {
  const words: string[] = [];
  let cur = '';
  let has = false;
  let i = 0;
  const n = line.length;
  while (i < n) {
    const ch = line[i];
    if (ch === ' ' || ch === '\t') {
      if (has) {
        words.push(cur);
        cur = '';
        has = false;
      }
      i += 1;
      continue;
    }
    has = true;
    if (ch === "'" ) {
      const end = line.indexOf("'", i + 1);
      if (end < 0) return null;
      cur += line.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    if (ch === '$' && line[i + 1] === "'") {
      i += 2;
      for (;;) {
        if (i >= n) return null;
        const c = line[i];
        if (c === "'") {
          i += 1;
          break;
        }
        if (c === '\\') {
          const e = line[i + 1];
          const map: Record<string, string> = { n: '\n', t: '\t', "'": "'", '\\': '\\', '"': '"' };
          cur += map[e] ?? e;
          i += 2;
          continue;
        }
        cur += c;
        i += 1;
      }
      continue;
    }
    if (ch === '"') {
      i += 1;
      for (;;) {
        if (i >= n) return null;
        const c = line[i];
        if (c === '"') {
          i += 1;
          break;
        }
        if (c === '\\' && i + 1 < n && '"\\$`'.includes(line[i + 1])) {
          cur += line[i + 1];
          i += 2;
          continue;
        }
        cur += c;
        i += 1;
      }
      continue;
    }
    if (ch === '\\' && i + 1 < n) {
      cur += line[i + 1];
      i += 2;
      continue;
    }
    cur += ch;
    i += 1;
  }
  if (has) words.push(cur);
  return words;
}

const UNSAFE = /[|;&<>`()]|\$\(/;

export function parseChannelSendCommand(command: string): ChannelSend | null {
  const line = command.trim();
  // One invocation, nothing composed around it.
  if (!line || line.includes('\n') || UNSAFE.test(line.replace(/\$'(?:[^'\\]|\\.)*'/g, ''))) return null;
  const words = splitShellWords(line);
  if (!words || words.length < 2) return null;

  // `teams send …`, `/usr/local/bin/slack send …`, `KEY=v teams send …`
  let at = 0;
  while (at < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[at])) at += 1;
  const cli = words[at]?.split('/').pop() ?? '';
  const platform = CLI_PLATFORM[cli];
  if (!platform || words[at + 1] !== 'send') return null;

  let text: string | null = null;
  let file: string | null = null;
  let channel: string | null = null;
  let textFile = false;
  const positional: string[] = [];
  for (let k = at + 2; k < words.length; k += 1) {
    const w = words[k];
    const eq = w.startsWith('--') ? w.indexOf('=') : -1;
    const flag = eq > 0 ? w.slice(0, eq) : w;
    const inline = eq > 0 ? w.slice(eq + 1) : undefined;
    const value = () => {
      if (inline !== undefined) return inline;
      k += 1;
      return words[k] ?? '';
    };
    switch (flag) {
      case '--text':
        text = value();
        break;
      case '--file':
        file = value().split('/').pop() ?? null;
        break;
      case '--channel':
        channel = value();
        break;
      case '--text-file':
        textFile = true;
        value();
        break;
      case '--reply-to':
      case '--chat':
      case '--thread':
      case '--card-file':
      case '--blocks':
      case '--blocks-file':
        value();
        break;
      default:
        if (w.startsWith('--')) break;
        positional.push(w);
    }
  }
  if (text === null && positional.length > 0) text = positional[0];
  if (textFile && text === null) return null;
  if (text === null && file === null) return null;
  return { platform, text: text?.trim() ? text.trim() : null, file, channel };
}
