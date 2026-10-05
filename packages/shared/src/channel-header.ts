// The pre-2026 channel prompt header: `[Slack · #general · message from <user>]`.
// New prompts no longer carry it, and old transcripts still do.
//
// Written as `/^\[(\w+)\s*·\s*([^·]+?)\s*·\s*message from\s+([^\]]+)\]\s*/`,
// the regex matched the same text but tried every split of a long space run
// (`\s*` against `[^·]+?`, and `\s+` against `[^\]]+`): 60k characters took
// 1.4 s with Bun and 2.1 s with Node. Here every character has one way to
// match. The groups keep their surrounding spaces and are trimmed below, which
// is all any reader used, so the result is the same.
const LEGACY_HEADER = /^\[(\w+)\s*·([^·]+)·\s*message from(\s[^\]]+)\]\s*/;

export interface LegacyChannelHeader {
  /** The platform word as written, such as `Slack`. */
  platform: string;
  /** The channel or chat, trimmed. */
  context: string;
  /** The sender, trimmed. */
  userName: string;
  /** The header's length, including the whitespace after its `]`. */
  length: number;
}

/** The header at the start of `text`, or null when `text` does not start with one. */
export function readLegacyChannelHeader(text: string): LegacyChannelHeader | null {
  const match = LEGACY_HEADER.exec(text);
  if (!match) return null;
  // Every group takes part in a match; the defaults only satisfy the type.
  const [whole, platform = '', context = '', userName = ''] = match;
  return { platform, context: context.trim(), userName: userName.trim(), length: whole.length };
}
