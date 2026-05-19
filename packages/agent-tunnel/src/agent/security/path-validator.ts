/**
 * Path Validator — defense-in-depth path traversal prevention.
 *
 * Validates that requested paths:
 *   1. Are absolute
 *   2. Resolve to an absolute path (follows symlinks)
 *   3. Fall within allowed directories
 *   4. Don't hit blocked paths (configurable)
 */

import { dirname, resolve, normalize } from 'path';
import { realpathSync } from 'fs';

function assertAllowedResolvedPath(
  originalPath: string,
  resolved: string,
  allowedPaths: string[],
  blockedPaths: string[] = [],
): void {
  for (const blocked of blockedPaths) {
    if (resolved === blocked || resolved.startsWith(blocked + '/')) {
      throw new Error(`Access denied: blocked path "${originalPath}"`);
    }
  }

  if (allowedPaths.length > 0) {
    const withinAllowed = allowedPaths.some((allowed) => {
      const normalizedAllowed = normalize(resolve(allowed));
      return resolved === normalizedAllowed || resolved.startsWith(normalizedAllowed + '/');
    });

    if (!withinAllowed) {
      throw new Error(`Access denied: path "${originalPath}" is outside allowed directories`);
    }
  }
}

export function validatePath(
  path: string,
  allowedPaths: string[],
  blockedPaths: string[] = [],
): void {
  if (!path) {
    throw new Error('Path is required');
  }

  const normalized = normalize(resolve(path));
  let resolved: string;
  try {
    resolved = realpathSync(normalized);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      resolved = normalized;
    } else {
      throw new Error(`Access denied: cannot resolve path "${path}" (${code})`);
    }
  }

  assertAllowedResolvedPath(path, resolved, allowedPaths, blockedPaths);
}

export function validateWritePath(
  path: string,
  allowedPaths: string[],
  blockedPaths: string[] = [],
): void {
  validatePath(path, allowedPaths, blockedPaths);

  let parent = dirname(normalize(resolve(path)));
  while (parent && parent !== dirname(parent)) {
    try {
      const resolvedParent = realpathSync(parent);
      assertAllowedResolvedPath(path, resolvedParent, allowedPaths, blockedPaths);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        throw new Error(`Access denied: cannot resolve parent for "${path}" (${code})`);
      }
      parent = dirname(parent);
    }
  }

  throw new Error(`Access denied: cannot resolve parent for "${path}"`);
}
