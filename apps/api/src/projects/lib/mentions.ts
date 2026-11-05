/**
 * Who a message mentions: the `@` tokens of a text and whether they name a
 * member (a person or a session). Used by artifact comment mentions.
 */

/** The `@` tokens in a message, lowercased: `@3f2a1b9c`, `@builder`, `@all`. */
export function mentionTokens(text: string): Set<string> {
  const out = new Set<string>();
  // `@ada@example.test` is one token: a person is mentioned by email too.
  for (const match of text.matchAll(/(?:^|[^\w@])@([a-z0-9][a-z0-9._+-]{1,63}(?:@[a-z0-9.-]+[a-z0-9])?)/gi)) out.add(match[1]!.toLowerCase().replace(/[._+-]+$/, ''));
  return out;
}

/**
 * True when `tokens` names this member: `@all`/`@here`, 8 or more leading
 * characters of one of its `ids` (a session id or a user id), or one of its
 * `names` written as a slug (`Fix CI` → `@fix-ci`).
 */
export function mentionsMember(tokens: Set<string>, member: { ids: readonly string[]; names: readonly string[] }): boolean {
  if (tokens.has('all') || tokens.has('here')) return true;
  for (const id of member.ids) {
    const lower = id.toLowerCase();
    for (const token of tokens) if (token.length >= 8 && lower.startsWith(token)) return true;
  }
  return member.names.some((name) => {
    const slug = name.toLowerCase().trim().replace(/[^a-z0-9._@+-]+/g, '-');
    return !!slug && tokens.has(slug);
  });
}
