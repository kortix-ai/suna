/**
 * What an agent's `permission` block says about one tool, for the rail
 * layout's Tools rows and its Approval rules card. A bare action applies to
 * every tool; a tool's own key wins over `*`; a pattern map (bash command
 * globs) reads as its `*` action, else as custom rules.
 */

import type { PermissionAction, PermissionConfig } from '@kortix/sdk';

export type ToolRule = PermissionAction | 'custom';

export function toolRule(permission: PermissionConfig | undefined, tool: string): ToolRule | undefined {
  if (permission === undefined) return undefined;
  if (typeof permission === 'string') return permission;
  const value = permission[tool] ?? permission['*'];
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value;
  const fallback = (value as Record<string, PermissionAction>)['*'];
  return typeof fallback === 'string' ? fallback : 'custom';
}

/** The patterns a pattern map denies ("rm -rf *"), across every tool. */
export function deniedPatterns(permission: PermissionConfig | undefined): string[] {
  if (!permission || typeof permission === 'string') return [];
  return Object.values(permission).flatMap((value) =>
    value && typeof value === 'object'
      ? Object.entries(value as Record<string, PermissionAction>)
          .filter(([pattern, action]) => pattern !== '*' && action === 'deny')
          .map(([pattern]) => pattern)
      : [],
  );
}
