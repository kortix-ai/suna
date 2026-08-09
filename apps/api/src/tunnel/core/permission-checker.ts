import { posix, win32 } from 'path';
import { eq, and } from 'drizzle-orm';
import { tunnelPermissions } from '@kortix/db';
import type { TunnelFilesystemScope, TunnelShellScope, TunnelPermissionScope } from '@kortix/db';
import { db } from '../../shared/db';
import {
  desktopFeatureForMethod,
  validateTunnelPermissionScope,
  type TunnelCapability,
} from 'agent-tunnel';

export interface PermissionCheckResult {
  allowed: boolean;
  permissionId?: string;
  reason?: string;
}

interface TunnelDesktopScope {
  features?: string[];
}

export async function checkPermission(
  tunnelId: string,
  capability: TunnelCapability,
  operation: string,
  args: Record<string, unknown>,
): Promise<PermissionCheckResult> {
  const permissions = await db
    .select()
    .from(tunnelPermissions)
    .where(
      and(
        eq(tunnelPermissions.tunnelId, tunnelId),
        eq(tunnelPermissions.capability, capability),
        eq(tunnelPermissions.status, 'active'),
      ),
    );

  if (permissions.length === 0) {
    return {
      allowed: false,
      reason: `No active permission for capability "${capability}"`,
    };
  }

  const now = new Date();
  for (const perm of permissions) {
    if (perm.expiresAt && new Date(perm.expiresAt) < now) {
      continue;
    }

    const validatedScope = validateTunnelPermissionScope(capability, perm.scope ?? {});
    if (!validatedScope.valid) {
      continue;
    }

    const scopeResult = validateScopeForOperation(
      capability,
      validatedScope.sanitized as TunnelPermissionScope,
      operation,
      args,
    );
    if (scopeResult.allowed) {
      return { allowed: true, permissionId: perm.permissionId };
    }
  }

  return {
    allowed: false,
    reason: `Operation "${operation}" not within any granted scope for "${capability}"`,
  };
}

export function validateScopeForOperation(
  capability: TunnelCapability,
  scope: TunnelPermissionScope | null,
  operation: string,
  args: Record<string, unknown>,
): PermissionCheckResult {
  if (!scope || Object.keys(scope).length === 0) {
    return { allowed: true };
  }

  switch (capability) {
    case 'filesystem':
      return validateFilesystemScope(scope as TunnelFilesystemScope, operation, args);
    case 'shell':
      return validateShellScope(scope as TunnelShellScope, operation, args);
    case 'desktop':
      return validateDesktopScope(scope as TunnelDesktopScope, operation, args);
    default:
      return {
        allowed: false,
        reason: `No scope validator for capability "${capability}"`,
      };
  }
}

function validateFilesystemScope(
  scope: TunnelFilesystemScope,
  operation: string,
  args: Record<string, unknown>,
): PermissionCheckResult {
  if (scope.operations && scope.operations.length > 0) {
    if (!scope.operations.includes(operation as any)) {
      return {
        allowed: false,
        reason: `Operation "${operation}" not in allowed operations`,
      };
    }
  }

  const targetPath = typeof args.path === 'string' ? args.path : '';
  if (!targetPath) {
    return { allowed: false, reason: 'A filesystem path is required' };
  }
  if (scope.paths && scope.paths.length > 0 && targetPath) {
    const pathAllowed = scope.paths.some((allowed) => {
      return isPathInside(targetPath, allowed);
    });
    if (!pathAllowed) {
      return {
        allowed: false,
        reason: `Path "${targetPath}" not within allowed paths`,
      };
    }
  }

  if (scope.maxFileSize && operation === 'write' && typeof args.content === 'string') {
    const encoding = args.encoding === 'base64' ? 'base64' : 'utf8';
    const size = Buffer.byteLength(args.content, encoding);
    if (size > scope.maxFileSize) {
      return {
        allowed: false,
        reason: `File size ${size} exceeds limit ${scope.maxFileSize}`,
      };
    }
  }

  if (scope.excludePatterns && scope.excludePatterns.length > 0 && targetPath) {
    const isExcluded = scope.excludePatterns.some((pattern) => {
      return matchGlob(targetPath, pattern);
    });
    if (isExcluded) {
      return {
        allowed: false,
        reason: `Path "${targetPath}" matches exclude pattern`,
      };
    }
  }

  return { allowed: true };
}

function validateShellScope(
  scope: TunnelShellScope,
  _operation: string,
  args: Record<string, unknown>,
): PermissionCheckResult {
  const command = (args.command as string) || '';
  if (scope.commands && scope.commands.length > 0 && command) {
    const executable = command.trim();
    if (!scope.commands.includes(executable)) {
      return {
        allowed: false,
        reason: `Command "${executable}" not in allowed commands`,
      };
    }
  }

  if (scope.workingDir) {
    if (typeof args.cwd !== 'string' || !isPathInside(args.cwd, scope.workingDir)) {
      return {
        allowed: false,
        reason: `Working directory "${args.cwd}" outside allowed directory`,
      };
    }
  }

  if (scope.maxTimeout !== undefined && args.timeout !== undefined) {
    const timeout = Number(args.timeout);
    if (!Number.isFinite(timeout) || timeout <= 0 || timeout > scope.maxTimeout) {
      return {
        allowed: false,
        reason: `Timeout exceeds limit ${scope.maxTimeout}`,
      };
    }
  }

  return { allowed: true };
}

function validateDesktopScope(
  scope: TunnelDesktopScope,
  operation: string,
  args: Record<string, unknown>,
): PermissionCheckResult {
  if (!scope.features || scope.features.length === 0) {
    return { allowed: true };
  }

  const method = `desktop.${operation}`;
  const feature = desktopFeatureForMethod(method, args);

  if (!feature) {
    return { allowed: false, reason: `Unknown desktop method: "${method}"` };
  }

  if (!scope.features.includes(feature)) {
    return {
      allowed: false,
      reason: `Feature "${feature}" not in allowed features`,
    };
  }

  return { allowed: true };
}

function matchGlob(path: string, pattern: string): boolean {
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '{{GLOBSTAR}}')
    .replace(/\*/g, '[^/]*')
    .replace(/\{\{GLOBSTAR\}\}/g, '.*');
  return new RegExp(`^${regexStr}$`).test(path);
}

function isPathInside(target: string, allowed: string): boolean {
  const windows = /^[a-zA-Z]:[\\/]/.test(target) || /^[a-zA-Z]:[\\/]/.test(allowed);
  const pathApi = windows ? win32 : posix;
  if (!pathApi.isAbsolute(target) || !pathApi.isAbsolute(allowed)) return false;
  let normalizedTarget = pathApi.normalize(target);
  let normalizedAllowed = pathApi.normalize(allowed);
  if (windows) {
    normalizedTarget = normalizedTarget.toLowerCase();
    normalizedAllowed = normalizedAllowed.toLowerCase();
  }
  const relative = pathApi.relative(normalizedAllowed, normalizedTarget);
  return relative === '' || (!relative.startsWith('..') && !pathApi.isAbsolute(relative));
}
