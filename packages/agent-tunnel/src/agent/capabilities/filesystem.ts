/**
 * Filesystem Capability — handles fs.read, fs.write, fs.list, fs.stat, fs.delete.
 *
 * All operations go through local-side path validation (defense in depth)
 * even though the server already validates permissions.
 */

import { readFile, writeFile, readdir, stat, unlink, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import type { Capability, RpcHandler } from './index';
import { validatePath, validateWritePath } from '../security/path-validator';
import type { TunnelConfig } from '../config';
import type { LocalPermission } from '../security/permission-guard';

function permissionFilesystemScope(params: Record<string, unknown>): {
  paths?: string[];
  allowedPaths?: string[];
  blockedPaths?: string[];
  operations?: string[];
  maxFileSize?: number;
} {
  const permission = params.__permission as LocalPermission | undefined;
  if (permission?.capability !== 'filesystem') {
    throw new Error('Permission denied: filesystem permission required');
  }
  return (permission.scope ?? {}) as {
    paths?: string[];
    blockedPaths?: string[];
    excludePatterns?: string[];
    operations?: string[];
    maxFileSize?: number;
  };
}

function effectiveAllowedPaths(config: TunnelConfig, params: Record<string, unknown>): string[] {
  const scope = permissionFilesystemScope(params);
  const scoped = Array.isArray(scope.paths)
    ? scope.paths.filter((p: unknown): p is string => typeof p === 'string' && p.trim().length > 0)
    : [];
  return scoped.length > 0 ? scoped : config.allowedPaths;
}

function effectiveBlockedPaths(config: TunnelConfig, params: Record<string, unknown>): string[] {
  const scope = permissionFilesystemScope(params);
  const scoped = Array.isArray(scope.blockedPaths) ? scope.blockedPaths.filter((p): p is string => typeof p === 'string' && p.trim().length > 0) : [];
  return [...config.blockedPaths, ...scoped];
}

export function createFilesystemCapability(config: TunnelConfig): Capability {
  const methods = new Map<string, RpcHandler>();

  methods.set('fs.read', async (params) => {
    const path = params.path as string;
    const encoding = (params.encoding as BufferEncoding) || 'utf-8';

    validatePath(path, effectiveAllowedPaths(config, params), effectiveBlockedPaths(config, params));

    const stats = await stat(path);
    const scope = permissionFilesystemScope(params);
    const maxFileSize = Math.min(config.maxFileSize, typeof scope.maxFileSize === 'number' ? scope.maxFileSize : config.maxFileSize);
    if (stats.size > maxFileSize) {
      throw new Error(`File exceeds max size (${stats.size} > ${maxFileSize})`);
    }

    const content = await readFile(path, { encoding });

    return {
      content,
      size: stats.size,
      encoding,
    };
  });


  methods.set('fs.write', async (params) => {
    const path = params.path as string;
    const content = params.content as string;
    const encoding = (params.encoding as BufferEncoding) || 'utf-8';

    validateWritePath(path, effectiveAllowedPaths(config, params), effectiveBlockedPaths(config, params));

    const scope = permissionFilesystemScope(params);
    const maxFileSize = Math.min(config.maxFileSize, typeof scope.maxFileSize === 'number' ? scope.maxFileSize : config.maxFileSize);
    if (content.length > maxFileSize) {
      throw new Error(`Content exceeds max size (${content.length} > ${maxFileSize})`);
    }

    await mkdir(dirname(path), { recursive: true });
    validateWritePath(path, effectiveAllowedPaths(config, params), effectiveBlockedPaths(config, params));

    await writeFile(path, content, { encoding });
    validatePath(path, effectiveAllowedPaths(config, params), effectiveBlockedPaths(config, params));
    const stats = await stat(path);

    return {
      size: stats.size,
      path,
    };
  });


  methods.set('fs.list', async (params) => {
    const path = params.path as string;
    const recursive = params.recursive as boolean || false;

    validatePath(path, effectiveAllowedPaths(config, params), effectiveBlockedPaths(config, params));

    const entries = await readdir(path, { withFileTypes: true });

    const result = entries.map((entry) => ({
      name: entry.name,
      path: join(path, entry.name),
      isDirectory: entry.isDirectory(),
      isFile: entry.isFile(),
      isSymlink: entry.isSymbolicLink(),
    }));

    if (recursive) {
      const dirs = result.filter((e) => e.isDirectory);
      for (const dir of dirs) {
        try {
          const subEntries = await readdir(dir.path, { withFileTypes: true });
          for (const sub of subEntries) {
            result.push({
              name: sub.name,
              path: join(dir.path, sub.name),
              isDirectory: sub.isDirectory(),
              isFile: sub.isFile(),
              isSymlink: sub.isSymbolicLink(),
            });
          }
        } catch {
        }
      }
    }

    return { entries: result, count: result.length };
  });


  methods.set('fs.stat', async (params) => {
    const path = params.path as string;

    validatePath(path, effectiveAllowedPaths(config, params), effectiveBlockedPaths(config, params));

    const stats = await stat(path);

    return {
      size: stats.size,
      isDirectory: stats.isDirectory(),
      isFile: stats.isFile(),
      isSymlink: stats.isSymbolicLink(),
      mode: stats.mode,
      mtime: stats.mtime.toISOString(),
      ctime: stats.ctime.toISOString(),
      atime: stats.atime.toISOString(),
    };
  });

  methods.set('fs.delete', async (params) => {
    const path = params.path as string;

    validatePath(path, effectiveAllowedPaths(config, params), effectiveBlockedPaths(config, params));

    await unlink(path);

    return { deleted: true, path };
  });

  return {
    name: 'filesystem',
    methods,
  };
}
