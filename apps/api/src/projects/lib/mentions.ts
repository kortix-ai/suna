/** Who a message mentions: the `@` tokens of a text. Used by space posts. */

/** The `@` tokens in a message, lowercased: `@3f2a1b9c`, `@builder`, `@all`. */
export function mentionTokens(text: string): Set<string> {
  const out = new Set<string>();
  // `@ada@example.test` is one token: a person is mentioned by email too.
  for (const match of text.matchAll(/(?:^|[^\w@])@([a-z0-9][a-z0-9._+-]{1,63}(?:@[a-z0-9.-]+[a-z0-9])?)/gi)) out.add(match[1]!.toLowerCase().replace(/[._+-]+$/, ''));
  return out;
}
