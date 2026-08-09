/**
 * Filesystem Capability — handles fs.read, fs.write, fs.list, fs.stat, fs.delete.
 *
 * All operations go through local-side path validation (defense in depth)
 * even though the server already validates permissions.
 */

import { open, writeFile, readdir, stat, unlink, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import type { Capability, RpcHandler } from './index';
import { validatePath, validateWritePath } from '../security/path-validator';
import type { TunnelConfig } from '../config';
import type { LocalPermission } from '../security/permission-guard';
import { operationForMethod } from '../../shared/permissions';

function permissionFilesystemScope(params: Record<string, unknown>): {
  paths?: string[];
  allowedPaths?: string[];
  blockedPaths?: string[];
  excludePatterns?: string[];
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

function scopedAllowedPaths(params: Record<string, unknown>): string[] {
  const scope = permissionFilesystemScope(params);
  return Array.isArray(scope.paths)
    ? scope.paths.filter((p: unknown): p is string => typeof p === 'string' && p.trim().length > 0)
    : [];
}

function effectiveBlockedPaths(config: TunnelConfig, params: Record<string, unknown>): string[] {
  const scope = permissionFilesystemScope(params);
  const scoped = Array.isArray(scope.blockedPaths)
    ? scope.blockedPaths.filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
    : [];
  return [...config.blockedPaths, ...scoped];
}

function validateFilesystemPath(
  path: string,
  config: TunnelConfig,
  params: Record<string, unknown>,
  write = false,
): string {
  const blocked = effectiveBlockedPaths(config, params);
  const validator = write ? validateWritePath : validatePath;
  const resolved = validator(path, config.allowedPaths, blocked);
  const scoped = scopedAllowedPaths(params);
  if (scoped.length > 0) validator(path, scoped, blocked);

  const scope = permissionFilesystemScope(params);
  const patterns = Array.isArray(scope.excludePatterns)
    ? scope.excludePatterns.filter((value): value is string => typeof value === 'string')
    : [];
  if (patterns.some((pattern) => matchGlob(path, pattern) || matchGlob(resolved, pattern))) {
    throw new Error(`Permission denied: path "${path}" matches an excluded pattern`);
  }
  return resolved;
}

function matchGlob(path: string, pattern: string): boolean {
  const regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '{{GLOBSTAR}}')
    .replace(/\*/g, '[^/\\\\]*')
    .replace(/\{\{GLOBSTAR\}\}/g, '.*');
  return new RegExp(`^${regex}$`).test(path);
}

function parseEncoding(value: unknown): 'utf8' | 'base64' {
  if (value === undefined || value === 'utf-8' || value === 'utf8') return 'utf8';
  if (value === 'base64') return 'base64';
  throw new Error('Encoding must be "utf-8" or "base64"');
}

function assertFilesystemOperation(params: Record<string, unknown>, method: string): void {
  const scope = permissionFilesystemScope(params);
  const operations = Array.isArray(scope.operations)
    ? scope.operations.filter((value): value is string => typeof value === 'string')
    : [];
  const operation = operationForMethod(method);
  if (operations.length > 0 && !operations.includes(operation)) {
    throw new Error(`Permission denied: filesystem operation "${operation}" is not allowed`);
  }
}

export function createFilesystemCapability(config: TunnelConfig): Capability {
  const methods = new Map<string, RpcHandler>();

  methods.set('fs.read', async (params) => {
    assertFilesystemOperation(params, 'fs.read');
    const path = params.path as string;
    const encoding = parseEncoding(params.encoding);

    validateFilesystemPath(path, config, params);

    const handle = await open(path, 'r');
    try {
      const stats = await handle.stat();
      const scope = permissionFilesystemScope(params);
      const maxFileSize = Math.min(
        config.maxFileSize,
        typeof scope.maxFileSize === 'number' ? scope.maxFileSize : config.maxFileSize,
      );
      if (stats.size > maxFileSize) {
        throw new Error(`File exceeds max size (${stats.size} > ${maxFileSize})`);
      }
      const content = await handle.readFile({ encoding });
      return {
        content,
        size: stats.size,
        encoding,
      };
    } finally {
      await handle.close();
    }
  });

  methods.set('fs.write', async (params) => {
    assertFilesystemOperation(params, 'fs.write');
    const path = params.path as string;
    const content = params.content as string;
    const encoding = parseEncoding(params.encoding);

    validateFilesystemPath(path, config, params, true);

    const scope = permissionFilesystemScope(params);
    const maxFileSize = Math.min(
      config.maxFileSize,
      typeof scope.maxFileSize === 'number' ? scope.maxFileSize : config.maxFileSize,
    );
    if (typeof content !== 'string') throw new Error('Content must be a string');
    const contentBytes = Buffer.byteLength(content, encoding);
    if (contentBytes > maxFileSize) {
      throw new Error(`Content exceeds max size (${contentBytes} > ${maxFileSize})`);
    }

    await mkdir(dirname(path), { recursive: true });
    validateFilesystemPath(path, config, params, true);

    await writeFile(path, content, { encoding });
    validateFilesystemPath(path, config, params);
    const stats = await stat(path);

    return {
      size: stats.size,
      path,
    };
  });

  methods.set('fs.list', async (params) => {
    assertFilesystemOperation(params, 'fs.list');
    const path = params.path as string;
    const recursive = (params.recursive as boolean) || false;

    validateFilesystemPath(path, config, params);

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
        } catch {}
      }
    }

    return { entries: result, count: result.length };
  });

  methods.set('fs.stat', async (params) => {
    assertFilesystemOperation(params, 'fs.stat');
    const path = params.path as string;

    validateFilesystemPath(path, config, params);

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
    assertFilesystemOperation(params, 'fs.delete');
    const path = params.path as string;

    validateFilesystemPath(path, config, params);

    await unlink(path);

    return { deleted: true, path };
  });

  return {
    name: 'filesystem',
    methods,
  };
}
