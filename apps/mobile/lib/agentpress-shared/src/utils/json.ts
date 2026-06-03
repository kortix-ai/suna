export function safeJsonParse<T>(
  jsonString: string | Record<string, any> | undefined | null,
  defaultValue: T
): T {
  if (jsonString === undefined || jsonString === null) return defaultValue;
  if (typeof jsonString === 'object') return jsonString as unknown as T;
  try {
    return JSON.parse(jsonString);
  } catch {
    return defaultValue;
  }
}
