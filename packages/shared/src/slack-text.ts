// Slack message markup as a person reads it, and the header of a Slack
// follow-up prompt. The session page renders channel messages with these; the
// API writes the header and a Slack session's title source with them.
//
// Slack text comes from anyone who can post in the channel, and every viewer
// of the session parses it, so the scan reads each character a bounded number
// of times.

/** Slack's `!here`, `!subteam^S…|@team`, `!date^…|fallback`: the label, else `@name`. */
function slackSpecialMention(inner: string, label: string): string {
  if (label) return label;
  const name = inner.slice(1).split('^')[0] ?? '';
  return `@${name}`;
}

/**
 * Slack message markup as a person reads it, in one pass: `<@U…|Sam>` is
 * `@Sam`, `<#C…|ops>` is `#ops`, `<!here>` is `@here`, `<https://…|label>` is
 * `label`, and `&lt;` `&gt;` `&amp;` are the characters. Any other `<…>` stays.
 */
export function slackPlainText(text: string): string {
  let out = '';
  let i = 0;
  for (;;) {
    const first = text.indexOf('<', i);
    const close = first < 0 ? -1 : text.indexOf('>', first + 1);
    if (close < 0) break;
    // The tag opens at the last `<` before its `>`. Every scan stays inside
    // `[i, close]` and the next starts after it, so each character is read a
    // bounded number of times. Searching back from a `>` with no `<` after `i`
    // re-read the text before it: 120k `>` took 120 ms, quadrupling per doubling.
    const open = text.lastIndexOf('<', close);
    const inner = text.slice(open + 1, close);
    const bar = inner.indexOf('|');
    const target = bar < 0 ? inner : inner.slice(0, bar);
    const label = bar < 0 ? '' : inner.slice(bar + 1);
    let shown: string | null = null;
    if (target.startsWith('@')) shown = `@${label || target.slice(1)}`;
    else if (target.startsWith('#')) shown = `#${label || target.slice(1)}`;
    else if (target.startsWith('!')) shown = slackSpecialMention(target, label);
    else if (target.includes('://') || target.startsWith('mailto:') || target.startsWith('tel:')) shown = label || target;
    out += text.slice(i, open) + (shown ?? text.slice(open, close + 1));
    i = close + 1;
  }
  out += text.slice(i);
  return out.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

const FOLLOW_UP_PREFIX = 'New message from ';
const FOLLOW_UP_CHANNEL = ' in Slack channel ';
const FOLLOW_UP_THREAD = ', thread ';

/**
 * The first line of a Slack follow-up prompt. The API writes it and the
 * session page reads it with `readSlackFollowUpHeader`: one format, one module.
 */
export function slackFollowUpHeader(user: string, channel: string, threadTs: string): string {
  return `${FOLLOW_UP_PREFIX}${user}${FOLLOW_UP_CHANNEL}${channel}${FOLLOW_UP_THREAD}${threadTs}:`;
}

/**
 * The sender, channel and thread of a follow-up header line; null for any other
 * line. The separators are found from the end: a channel label and a thread ts
 * never contain them, and a person's display name can.
 */
export function readSlackFollowUpHeader(line: string): { user: string; channel: string; threadTs: string } | null {
  if (!line.startsWith(FOLLOW_UP_PREFIX) || !line.endsWith(':')) return null;
  const thread = line.lastIndexOf(FOLLOW_UP_THREAD);
  const at = thread < 0 ? -1 : line.lastIndexOf(FOLLOW_UP_CHANNEL, thread);
  if (at < FOLLOW_UP_PREFIX.length) return null;
  return {
    user: line.slice(FOLLOW_UP_PREFIX.length, at).trim(),
    channel: line.slice(at + FOLLOW_UP_CHANNEL.length, thread).trim(),
    threadTs: line.slice(thread + FOLLOW_UP_THREAD.length, -1).trim(),
  };
}
