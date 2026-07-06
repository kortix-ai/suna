/**
 * Error-message unwrapping — extracted from turns/index.ts so it can be
 * shared with classify.ts (classifyTurn's TurnError normalization) without
 * creating an index.ts <-> classify.ts import cycle.
 */

/**
 * Extract human-readable error message from a raw error value.
 * Matches SolidJS `unwrap()` function — session-turn.tsx:34-81
 */
export function unwrapError(raw: unknown): string {
  if (!raw) return 'An error occurred';

  if (typeof raw === 'string') {
    // Strip "Error: " prefix
    let str = raw.startsWith('Error: ') ? raw.slice(7) : raw;

    // Try JSON parsing (might be double-encoded)
    try {
      const parsed = JSON.parse(str);
      if (typeof parsed === 'string') {
        str = parsed; // double-encoded string
        try {
          const inner = JSON.parse(str);
          return extractErrorFromObject(inner) || str;
        } catch {
          return str;
        }
      }
      return extractErrorFromObject(parsed) || str;
    } catch {
      return str;
    }
  }

  // (`!raw` at the top already excluded null — typeof alone suffices here.)
  if (typeof raw === 'object') {
    return extractErrorFromObject(raw) || 'An error occurred';
  }

  return String(raw);
}

function extractErrorFromObject(obj: unknown): string | undefined {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return undefined;
  // Try common error shapes
  const record = obj as Record<string, unknown>;
  if (typeof record.message === 'string' && record.message) return record.message;
  if (typeof record.error === 'string' && record.error) return record.error;
  const data = record.data as { message?: unknown } | undefined | null;
  if (typeof data?.message === 'string') return data.message;
  const error = record.error as { message?: unknown } | undefined | null;
  if (typeof error?.message === 'string') return error.message;
  return undefined;
}
