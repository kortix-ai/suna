import type { Effect } from 'effect';
import { resolve, normalize } from 'path';
import { eq, and } from 'drizzle-orm';
import { tunnelPermissions } from '@kortix/db';
import type { TunnelFilesystemScope, TunnelShellScope, TunnelPermissionScope } from '@kortix/db';
import { sharedDb as db } from '../../shared/effect';
import type { TunnelCapability } from 'agent-tunnel';

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

const DESKTOP_METHOD_FEATURES: Record<string, string> = {
  'desktop.cua.ensure': 'computer_use',
  'desktop.cua.start_daemon': 'computer_use',
  'desktop.cua.status': 'computer_use',
  'desktop.cua.version': 'computer_use',
  'desktop.cua.list_tools': 'computer_use',
  'desktop.cua.describe': 'computer_use',
  'desktop.cua.bring_to_front': 'windows',
  'desktop.cua.check_for_update': 'computer_use',
  'desktop.cua.check_permissions': 'computer_use',
  'desktop.cua.click': 'mouse',
  'desktop.cua.double_click': 'mouse',
  'desktop.cua.drag': 'mouse',
  'desktop.cua.end_session': 'computer_use',
  'desktop.cua.get_accessibility_tree': 'accessibility',
  'desktop.cua.get_agent_cursor_state': 'mouse',
  'desktop.cua.get_config': 'computer_use',
  'desktop.cua.get_cursor_position': 'mouse',
  'desktop.cua.get_recording_state': 'computer_use',
  'desktop.cua.get_screen_size': 'screenshot',
  'desktop.cua.get_window_state': 'accessibility',
  'desktop.cua.hotkey': 'keyboard',
  'desktop.cua.kill_app': 'apps',
  'desktop.cua.launch_app': 'apps',
  'desktop.cua.list_apps': 'apps',
  'desktop.cua.list_windows': 'windows',
  'desktop.cua.move_cursor': 'mouse',
  'desktop.cua.page': 'accessibility',
  'desktop.cua.press_key': 'keyboard',
  'desktop.cua.replay_trajectory': 'computer_use',
  'desktop.cua.right_click': 'mouse',
  'desktop.cua.scroll': 'keyboard',
  'desktop.cua.set_agent_cursor_enabled': 'mouse',
  'desktop.cua.set_agent_cursor_motion': 'mouse',
  'desktop.cua.set_agent_cursor_style': 'mouse',
  'desktop.cua.set_config': 'computer_use',
  'desktop.cua.set_value': 'accessibility',
  'desktop.cua.start_recording': 'screenshot',
  'desktop.cua.install_ffmpeg': 'computer_use',
  'desktop.cua.start_session': 'computer_use',
  'desktop.cua.stop_recording': 'screenshot',
  'desktop.cua.type_text': 'keyboard',
  'desktop.cua.zoom': 'screenshot',
};

export function desktopFeatureForMethod(method: string, args: Record<string, unknown> = {}): string | undefined {
  if (method === 'desktop.cua.call') {
    const tool = args.tool;
    if (typeof tool !== 'string' || tool.length === 0) {
      return undefined;
    }
    const toolMethod = tool.startsWith('desktop.cua.') ? tool : `desktop.cua.${tool}`;
    return DESKTOP_METHOD_FEATURES[toolMethod];
  }

  return DESKTOP_METHOD_FEATURES[method];
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
