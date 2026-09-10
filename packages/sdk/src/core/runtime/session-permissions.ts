import type { PermissionRuleset } from '@opencode-ai/sdk/v2/client';

export function sessionAllowsAllPermissions(
  rules: PermissionRuleset | undefined,
): boolean | undefined {
  if (rules === undefined) return undefined;
  const blanket = rules.findLastIndex((rule) => rule.permission === '*' && rule.pattern === '*');
  return blanket >= 0 && rules.slice(blanket).every((rule) => rule.action === 'allow');
}
