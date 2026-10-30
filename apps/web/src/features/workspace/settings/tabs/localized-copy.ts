/** Translate the existing copy shape without a second table of identical keys. */
export function localizedCopy<T>(
  defaults: T,
  t: (key: string, values?: Record<string, string | number>) => string,
  prefix = '',
): T {
  if (typeof defaults === 'function') {
    const parameter = prefix === 'connectedAs' ? 'name' : 'count';
    return ((value: string | number) => t(prefix, { [parameter]: value })) as T;
  }
  if (typeof defaults === 'string') return t(prefix) as T;
  return Object.fromEntries(
    Object.entries(defaults as Record<string, unknown>).map(([key, value]) => [
      key,
      localizedCopy(value, t, prefix ? `${prefix}.${key}` : key),
    ]),
  ) as T;
}
