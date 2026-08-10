/**
 * Path Validator — defense-in-depth path traversal prevention.
 *
 * Validates that requested paths:
 *   1. Are absolute
 *   2. Resolve to an absolute path (follows symlinks)
 *   3. Fall within allowed directories
 *   4. Don't hit blocked paths (configurable)
 */

import { dirname, basename, join, resolve, normalize, relative, isAbsolute } from 'path';
import { realpathSync } from 'fs';

function resolveExistingRoot(path: string): string {
  const normalized = normalize(resolve(path));
  try {
    return realpathSync(normalized);
  } catch {
    return normalized;
  }
}

function resolvePathForValidation(path: string): string {
  const normalized = normalize(resolve(path));
  try {
    return realpathSync(normalized);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      throw new Error(`Access denied: cannot resolve path "${path}" (${code})`);
    }

    const parent = dirname(normalized);
    if (parent === normalized) return normalized;
    return join(resolvePathForValidation(parent), basename(normalized));
  }
}

function assertAllowedResolvedPath(
  originalPath: string,
  resolved: string,
  allowedPaths: string[],
  blockedPaths: string[] = [],
): void {
  for (const blocked of blockedPaths) {
    const normalizedBlocked = resolveExistingRoot(blocked);
    if (isPathInside(resolved, normalizedBlocked)) {
      throw new Error(`Access denied: blocked path "${originalPath}"`);
    }
  }

  if (allowedPaths.length > 0) {
    const withinAllowed = allowedPaths.some((allowed) => {
      const normalizedAllowed = resolveExistingRoot(allowed);
      return isPathInside(resolved, normalizedAllowed);
    });

    if (!withinAllowed) {
      throw new Error(`Access denied: path "${originalPath}" is outside allowed directories`);
    }
  }
}

function isPathInside(target: string, root: string): boolean {
  const child = relative(root, target);
  return child === '' || (!child.startsWith('..') && !isAbsolute(child));
}

export function validatePath(
  path: string,
  allowedPaths: string[],
  blockedPaths: string[] = [],
): string {
  if (!path) {
    throw new Error('Path is required');
  }

  const resolved = resolvePathForValidation(path);

  assertAllowedResolvedPath(path, resolved, allowedPaths, blockedPaths);
  return resolved;
}

export function validateWritePath(
  path: string,
  allowedPaths: string[],
  blockedPaths: string[] = [],
): string {
  const resolved = validatePath(path, allowedPaths, blockedPaths);

  let parent = dirname(normalize(resolve(path)));
  while (parent && parent !== dirname(parent)) {
    try {
      const resolvedParent = realpathSync(parent);
      assertAllowedResolvedPath(path, resolvedParent, allowedPaths, blockedPaths);
      return resolved;
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
