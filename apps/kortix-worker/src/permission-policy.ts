export type PermissionAction = 'ask' | 'allow' | 'deny';
export type PermissionRuleConfig = PermissionAction | Record<string, PermissionAction>;
export type PermissionConfig = PermissionAction | Record<string, PermissionRuleConfig | undefined>;

export interface PermissionRule {
  permission: string;
  pattern: string;
  action: PermissionAction;
}

export type PermissionRuleset = readonly PermissionRule[];

const DEFAULT_PERMISSION_CONFIG: Record<string, PermissionRuleConfig> = {
  '*': 'allow',
  doom_loop: 'ask',
  external_directory: 'ask',
  read: {
    '*': 'allow',
    '*.env': 'deny',
    '*.env.*': 'deny',
    '*.env.example': 'allow',
  },
};

function isPermissionAction(value: unknown): value is PermissionAction {
  return value === 'ask' || value === 'allow' || value === 'deny';
}

export function wildcardMatch(value: string, pattern: string): boolean {
  const normalized = pattern.replaceAll('\\', '/');
  const optionalArguments = normalized.endsWith(' *');
  let source = '^';
  for (const character of optionalArguments ? normalized.slice(0, -2) : normalized) {
    if (character === '*') source += '.*';
    else if (character === '?') source += '.';
    else source += character.replace(/[\\^$+?.()|{}[\]]/g, '\\$&');
  }
  if (optionalArguments) source += '(?: .*)?';
  return new RegExp(`${source}$`, process.platform === 'win32' ? 'si' : 's').test(
    value.replaceAll('\\', '/'),
  );
}

export function permissionRulesFromConfig(config: PermissionConfig): PermissionRule[] {
  const normalized = isPermissionAction(config) ? { '*': config } : config;
  const rules: PermissionRule[] = [];
  for (const [permission, value] of Object.entries(normalized)) {
    if (value === undefined) continue;
    if (isPermissionAction(value)) {
      rules.push({ permission, pattern: '*', action: value });
      continue;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError(`permission.${permission} is not a valid permission rule`);
    }
    for (const [pattern, action] of Object.entries(value)) {
      if (!isPermissionAction(action)) {
        throw new TypeError(`permission.${permission}.${pattern} is not a valid permission action`);
      }
      rules.push({ permission, pattern, action });
    }
  }
  return rules;
}

export function compilePermissionRules(config?: PermissionConfig): PermissionRule[] {
  return [
    ...permissionRulesFromConfig(DEFAULT_PERMISSION_CONFIG),
    ...(config === undefined ? [] : permissionRulesFromConfig(config)),
  ];
}

export function evaluatePermission(
  permission: string,
  pattern: string,
  ruleset: PermissionRuleset,
): PermissionRule {
  for (let index = ruleset.length - 1; index >= 0; index -= 1) {
    const rule = ruleset[index];
    if (!rule) continue;
    if (wildcardMatch(permission, rule.permission) && wildcardMatch(pattern, rule.pattern)) {
      return rule;
    }
  }
  return { permission, pattern: '*', action: 'ask' };
}

export function permissionNameForTool(toolName: string): string {
  return toolName === 'write' || toolName === 'edit' ? 'edit' : toolName;
}
