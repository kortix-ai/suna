/**
 * Save a batch of tool API keys, returning which succeeded and which failed.
 *
 * Extracted from the onboarding setup wizard so the success/failure aggregation
 * can be unit-tested. The previous inline loop swallowed every error with
 * `.catch(() => {})`, ignored the HTTP status, and then reported success
 * unconditionally — so a fully-failed save still showed "N keys saved".
 *
 * `put` resolves `{ ok }` for an HTTP-level result; a thrown error (e.g. a
 * network failure) is treated as a failure for that key.
 */
export async function saveToolKeys(
  entries: readonly (readonly [string, string])[],
  put: (key: string, value: string) => Promise<{ ok: boolean }>,
): Promise<{ succeeded: string[]; failed: string[] }> {
  const succeeded: string[] = [];
  const failed: string[] = [];
  for (const [key, value] of entries) {
    try {
      const { ok } = await put(key, value);
      if (ok) succeeded.push(key);
      else failed.push(key);
    } catch {
      failed.push(key);
    }
  }
  return { succeeded, failed };
}
