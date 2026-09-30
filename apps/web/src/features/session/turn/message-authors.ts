/** Only distinguish known human authors; old messages have no reliable identity. */
export function visibleMessageAuthors(authors: Record<string, string | null>): Record<string, string> {
  const names = Object.values(authors).filter((name): name is string => !!name);
  if (new Set(names).size < 2) return {};
  return Object.fromEntries(Object.entries(authors).filter((entry): entry is [string, string] => !!entry[1]));
}
