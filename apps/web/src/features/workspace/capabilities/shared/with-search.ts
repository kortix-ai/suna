/** `href` with the request's query string carried over, so a redirect keeps deep-link state. */
export function withSearch(href: string, search: Record<string, string | string[] | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) {
    for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) query.append(key, item);
  }
  const text = query.toString();
  return text ? `${href}?${text}` : href;
}
