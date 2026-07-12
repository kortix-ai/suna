/**
 * Safe `process.env.<name>` read. Non-Next hosts (React Native, a bare browser
 * bundle, a CLI) may not define a `process` global at all — touching
 * `process.env` there throws a ReferenceError, not just returns `undefined`.
 */
export function safeEnv(name: string): string | undefined {
  try {
    return typeof process !== 'undefined' ? process.env?.[name] : undefined;
  } catch {
    return undefined;
  }
}
