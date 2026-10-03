/**
 * Teams wraps a channel @-mention of the bot in `<at>…</at>`. Sessions titled
 * from such a message before the API stripped it (#7388) still carry the tag
 * in `name`; nothing a person reads should show it.
 */
export function stripChatMentionMarkup(value: string): string {
  return value
    .replace(/<at[^>]*>.*?<\/at>/gi, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

