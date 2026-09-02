/**
 * Path rules for a shared filesystem.
 *
 * A filesystem is a flat key space, not a mounted disk — but agents write paths
 * that LOOK like a disk (`notes/2026/plan.md`), and the moment a path is a
 * string an agent controls, traversal is the bug to prevent. Every path is
 * normalised to one canonical form on the way in, so `a/./b`, `a//b` and
 * `/a/b` are the same key and `../` cannot exist at all.
 *
 * Rejecting rather than silently rewriting a traversal is deliberate: an agent
 * that meant `../shared/x` should be told it cannot, not quietly handed
 * `shared/x`, which would be a different file than it asked for.
 */

export const MAX_PATH_LENGTH = 1024;
export const MAX_PATH_SEGMENTS = 64;

export type PathResult = { ok: true; path: string } | { ok: false; reason: string };

export function normalizeFilePath(raw: string): PathResult {
  if (typeof raw !== 'string') return { ok: false, reason: 'path must be a string' };

  // A NUL byte truncates the path for anything that later hands it to a C
  // string, so the stored key and the used key could differ.
  if (raw.includes('\0')) return { ok: false, reason: 'path must not contain a NUL byte' };

  // DO NOT DECODE HERE. The transport already did: the path arrives as
  // `?path=`, and Hono percent-decodes query values before a handler sees them.
  // Decoding again made two different names collide — `?path=a%252Fb` (the
  // literal name `a%2Fb`) decoded to `a%2Fb` at the router and then to `a/b`
  // here, landing on the same key as the genuinely nested `a/b` and silently
  // overwriting it. Measured against the deployed preview: two writes, one row.
  //
  // What survives is the REFUSAL. A segment that still contains an encoded
  // separator or dot-segment at this point is either a mistake or an attempt,
  // never a name worth storing, so it is rejected rather than decoded.
  const unified = raw.replace(/\\/g, '/');

  const segments: string[] = [];
  for (const segment of unified.split('/')) {
    if (segment === '' || segment === '.') continue; // `a//b` and `a/./b`
    if (segment === '..') return { ok: false, reason: 'path must not contain ".." segments' };
    // An encoded separator, dot-segment or NUL inside ONE segment: `%2e%2e`,
    // `%2f`, `%5c`, `%00`. Decoding it would alias onto a different path;
    // storing it would hand the next consumer a name that decodes to something
    // else again — and an encoded NUL still truncates a C string downstream.
    if (/%(2e|2f|5c|00)/i.test(segment)) {
      let probe = segment;
      try {
        probe = decodeURIComponent(segment);
      } catch {
        return { ok: false, reason: 'path is not valid percent-encoding' };
      }
      if (probe.includes('\0')) return { ok: false, reason: 'path must not contain a NUL byte' };
      if (probe === '..' || probe === '.' || probe.includes('/') || probe.includes('\\')) {
        return {
          ok: false,
          reason: 'path must not contain percent-encoded separators or ".." segments',
        };
      }
    }
    segments.push(segment);
  }

  if (segments.length === 0) return { ok: false, reason: 'path must not be empty' };
  if (segments.length > MAX_PATH_SEGMENTS) {
    return { ok: false, reason: `path must have at most ${MAX_PATH_SEGMENTS} segments` };
  }

  const path = segments.join('/');
  if (path.length > MAX_PATH_LENGTH) {
    return { ok: false, reason: `path must be at most ${MAX_PATH_LENGTH} characters` };
  }
  return { ok: true, path };
}

/** Filesystem names are addressed in URLs and by agents, so keep them plain. */
export function normalizeFilesystemName(raw: string): PathResult {
  if (typeof raw !== 'string') return { ok: false, reason: 'name must be a string' };
  const name = raw.trim();
  if (!name) return { ok: false, reason: 'name must not be empty' };
  if (name.length > 128) return { ok: false, reason: 'name must be at most 128 characters' };
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) {
    return {
      ok: false,
      reason: 'name must start alphanumeric and contain only letters, digits, dot, dash, underscore',
    };
  }
  return { ok: true, path: name };
}

/**
 * A listing prefix. Unlike a file path an empty prefix is legal — it means
 * "everything" — so this cannot reuse normalizeFilePath's empty check.
 */
export function normalizeListPrefix(raw: string | undefined | null): PathResult {
  if (raw === undefined || raw === null || raw === '') return { ok: true, path: '' };
  const normalized = normalizeFilePath(raw);
  if (!normalized.ok) return normalized;
  // Match on a segment boundary so prefix `not` cannot return `notes/x`.
  return { ok: true, path: normalized.path.endsWith('/') ? normalized.path : `${normalized.path}/` };
}
