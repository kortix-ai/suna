import { resolve, normalize } from 'path';
import { eq, and } from 'drizzle-orm';
import { tunnelPermissions } from '@kortix/db';
import type { TunnelFilesystemScope, TunnelShellScope, TunnelPermissionScope } from '@kortix/db';
import { db } from '../../shared/db';
import type { TunnelCapability } from 'agent-tunnel';

export interface PermissionCheckResult {
  allowed: boolean;
  permissionId?: string;
  reason?: string;
}

interface TunnelNetworkScope {
  ports?: number[];
  hosts?: string[];
  protocols?: string[];
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
    return { allowed: false, reason: `No active permission for capability "${capability}"` };
  }

  const now = new Date();
  for (const perm of permissions) {
    if (perm.expiresAt && new Date(perm.expiresAt) < now) {
      continue;
    }

    const scopeResult = validateScope(capability, perm.scope as TunnelPermissionScope, operation, args);
    if (scopeResult.allowed) {
      return { allowed: true, permissionId: perm.permissionId };
    }
  }

  return { allowed: false, reason: `Operation "${operation}" not within any granted scope for "${capability}"` };
}

function validateScope(
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
    case 'network':
      return validateNetworkScope(scope as TunnelNetworkScope, operation, args);
    case 'desktop':
      return validateDesktopScope(scope as TunnelDesktopScope, operation, args);
    default:
      return { allowed: false, reason: `No scope validator for capability "${capability}"` };
  }
}

function validateFilesystemScope(
  scope: TunnelFilesystemScope,
  operation: string,
  args: Record<string, unknown>,
): PermissionCheckResult {
  if (scope.operations && scope.operations.length > 0) {
    if (!scope.operations.includes(operation as any)) {
      return { allowed: false, reason: `Operation "${operation}" not in allowed operations` };
    }
  }

  const targetPath = (args.path as string) || '';
  if (scope.paths && scope.paths.length > 0 && targetPath) {
    const pathAllowed = scope.paths.some((allowed) => {
      const normalizedTarget = normalize(resolve(targetPath));
      const normalizedAllowed = normalize(resolve(allowed));
      return normalizedTarget === normalizedAllowed || normalizedTarget.startsWith(normalizedAllowed + '/');
    });
    if (!pathAllowed) {
      return { allowed: false, reason: `Path "${targetPath}" not within allowed paths` };
    }
  }

  if (scope.maxFileSize && typeof args.size === 'number') {
    if (args.size > scope.maxFileSize) {
      return { allowed: false, reason: `File size ${args.size} exceeds limit ${scope.maxFileSize}` };
    }
  }

  if (scope.excludePatterns && scope.excludePatterns.length > 0 && targetPath) {
    const isExcluded = scope.excludePatterns.some((pattern) => {
      return matchGlob(targetPath, pattern);
    });
    if (isExcluded) {
      return { allowed: false, reason: `Path "${targetPath}" matches exclude pattern` };
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
    const executable = command.split(/\s+/)[0];
    if (!scope.commands.includes(executable)) {
      return { allowed: false, reason: `Command "${executable}" not in allowed commands` };
    }
  }

  if (scope.workingDir && args.cwd) {
    const normalizedCwd = normalize(resolve(args.cwd as string));
    const normalizedAllowed = normalize(resolve(scope.workingDir));
    if (!normalizedCwd.startsWith(normalizedAllowed) && normalizedCwd !== normalizedAllowed) {
      return { allowed: false, reason: `Working directory "${args.cwd}" outside allowed directory` };
    }
  }

  return { allowed: true };
}

function validateNetworkScope(
  scope: TunnelNetworkScope,
  _operation: string,
  args: Record<string, unknown>,
): PermissionCheckResult {
  if (scope.ports && scope.ports.length > 0) {
    const port = args.port as number | undefined;
    if (port !== undefined && !scope.ports.includes(port)) {
      return { allowed: false, reason: `Port ${port} not in allowed ports` };
    }
  }

  if (scope.hosts && scope.hosts.length > 0) {
    const host = args.host as string | undefined;
    if (host && !scope.hosts.includes(host)) {
      return { allowed: false, reason: `Host "${host}" not in allowed hosts` };
    }
  }

  if (scope.protocols && scope.protocols.length > 0) {
    const protocol = args.protocol as string | undefined;
    if (protocol && !scope.protocols.includes(protocol)) {
      return { allowed: false, reason: `Protocol "${protocol}" not in allowed protocols` };
    }
  }

  return { allowed: true };
}

const DESKTOP_METHOD_FEATURES: Record<string, string> = {
  'desktop.screenshot': 'screenshot',
  'desktop.cursor.image': 'screenshot',
  'desktop.screen.info': 'screenshot',
  'desktop.mouse.click': 'mouse',
  'desktop.mouse.move': 'mouse',
  'desktop.mouse.drag': 'mouse',
  'desktop.mouse.scroll': 'mouse',
  'desktop.mouse.position': 'mouse',
  'desktop.keyboard.type': 'keyboard',
  'desktop.keyboard.key': 'keyboard',
  'desktop.window.list': 'windows',
  'desktop.window.focus': 'windows',
  'desktop.window.resize': 'windows',
  'desktop.window.close': 'windows',
  'desktop.window.minimize': 'windows',
  'desktop.app.launch': 'apps',
  'desktop.app.quit': 'apps',
  'desktop.app.list': 'apps',
  'desktop.clipboard.read': 'clipboard',
  'desktop.clipboard.write': 'clipboard',
  'desktop.ax.tree': 'accessibility',
  'desktop.ax.action': 'accessibility',
  'desktop.ax.set_value': 'accessibility',
  'desktop.ax.focus': 'accessibility',
  'desktop.ax.search': 'accessibility',
};

function validateDesktopScope(
  scope: TunnelDesktopScope,
  operation: string,
  _args: Record<string, unknown>,
): PermissionCheckResult {
  if (!scope.features || scope.features.length === 0) {
    return { allowed: true };
  }

  const method = `desktop.${operation}`;
  const feature = DESKTOP_METHOD_FEATURES[method];

  if (!feature) {
    return { allowed: false, reason: `Unknown desktop method: "${method}"` };
  }

  if (!scope.features.includes(feature)) {
    return { allowed: false, reason: `Feature "${feature}" not in allowed features` };
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
