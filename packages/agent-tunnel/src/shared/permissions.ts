import { TunnelMethods, type TunnelCapability } from './types';

const VALID_CAPABILITIES = new Set<TunnelCapability>(['filesystem', 'shell', 'desktop']);
const VALID_FILESYSTEM_OPERATIONS = new Set(['read', 'write', 'list', 'delete']);
const VALID_DESKTOP_FEATURES = new Set([
  'screenshot',
  'mouse',
  'keyboard',
  'windows',
  'apps',
  'clipboard',
  'accessibility',
  'computer_use',
]);

export interface PermissionScopeValidationResult {
  valid: boolean;
  error?: string;
  sanitized?: Record<string, unknown>;
}

const DESKTOP_METHOD_FEATURES: Readonly<Record<string, string>> = {
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

export function capabilityForMethod(method: string): TunnelCapability | null {
  const capability = (TunnelMethods as Readonly<Record<string, TunnelCapability | null>>)[method];
  return capability ?? null;
}

export function isTunnelCapability(value: string): value is TunnelCapability {
  return VALID_CAPABILITIES.has(value as TunnelCapability);
}

/**
 * Validate permission scopes at every trust boundary.
 *
 * An empty object is the explicit unrestricted scope. A present restriction
 * field must contain at least one value. This prevents `{ commands: [] }`,
 * `{ paths: [] }`, or `{ features: [] }` from silently becoming unrestricted.
 */
export function validateTunnelPermissionScope(
  capability: string,
  input: unknown,
): PermissionScopeValidationResult {
  if (!isTunnelCapability(capability)) {
    return { valid: false, error: `Unknown capability: ${capability}` };
  }
  if (!isPlainRecord(input)) {
    return { valid: false, error: 'Scope must be an object' };
  }
  if (Object.keys(input).length === 0) {
    return { valid: true, sanitized: {} };
  }

  switch (capability) {
    case 'filesystem':
      return validateFilesystemScope(input);
    case 'shell':
      return validateShellScope(input);
    case 'desktop':
      return validateDesktopScope(input);
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function rejectUnknownFields(
  scope: Record<string, unknown>,
  allowed: readonly string[],
): PermissionScopeValidationResult | null {
  const unknown = Object.keys(scope).find((key) => !allowed.includes(key));
  return unknown ? { valid: false, error: `Unknown scope field: "${unknown}"` } : null;
}

function copyScopeLabel(
  scope: Record<string, unknown>,
  sanitized: Record<string, unknown>,
): PermissionScopeValidationResult | null {
  if (!('scope' in scope)) return null;
  if (typeof scope.scope !== 'string' || scope.scope.length === 0 || scope.scope.length > 255) {
    return { valid: false, error: 'scope.scope must be a string between 1 and 255 characters' };
  }
  sanitized.scope = scope.scope;
  return null;
}

function validateNonEmptyStringArray(
  value: unknown,
  field: string,
  options: { maxItems?: number; maxLength?: number } = {},
): PermissionScopeValidationResult | string[] {
  const maxItems = options.maxItems ?? 100;
  const maxLength = options.maxLength ?? 4096;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > maxItems ||
    !value.every(
      (item) =>
        typeof item === 'string' &&
        item.length > 0 &&
        item.length <= maxLength,
    ) ||
    new Set(value).size !== value.length
  ) {
    return {
      valid: false,
      error: `scope.${field} must contain 1-${maxItems} unique non-empty strings`,
    };
  }
  return [...value];
}

function validateFilesystemScope(scope: Record<string, unknown>): PermissionScopeValidationResult {
  const unknown = rejectUnknownFields(scope, [
    'scope',
    'paths',
    'operations',
    'excludePatterns',
    'maxFileSize',
  ]);
  if (unknown) return unknown;
  const sanitized: Record<string, unknown> = {};
  const labelError = copyScopeLabel(scope, sanitized);
  if (labelError) return labelError;

  if ('paths' in scope) {
    const paths = validateNonEmptyStringArray(scope.paths, 'paths');
    if (!Array.isArray(paths)) return paths;
    sanitized.paths = paths;
  }
  if ('operations' in scope) {
    const operations = validateNonEmptyStringArray(scope.operations, 'operations', {
      maxItems: VALID_FILESYSTEM_OPERATIONS.size,
      maxLength: 16,
    });
    if (!Array.isArray(operations)) return operations;
    const invalid = operations.find((operation) => !VALID_FILESYSTEM_OPERATIONS.has(operation));
    if (invalid) return { valid: false, error: `Invalid filesystem operation: "${invalid}"` };
    sanitized.operations = operations;
  }
  if ('excludePatterns' in scope) {
    if (!Array.isArray(scope.excludePatterns)) {
      return { valid: false, error: 'scope.excludePatterns must be an array of strings' };
    }
    if (
      scope.excludePatterns.length > 100 ||
      !scope.excludePatterns.every(
        (pattern) => typeof pattern === 'string' && pattern.length > 0 && pattern.length <= 1024,
      ) ||
      new Set(scope.excludePatterns).size !== scope.excludePatterns.length
    ) {
      return {
        valid: false,
        error: 'scope.excludePatterns must contain at most 100 unique non-empty strings',
      };
    }
    sanitized.excludePatterns = [...scope.excludePatterns];
  }
  if ('maxFileSize' in scope) {
    if (
      typeof scope.maxFileSize !== 'number' ||
      !Number.isSafeInteger(scope.maxFileSize) ||
      scope.maxFileSize <= 0
    ) {
      return { valid: false, error: 'scope.maxFileSize must be a positive safe integer' };
    }
    sanitized.maxFileSize = scope.maxFileSize;
  }
  return { valid: true, sanitized };
}

function validateShellScope(scope: Record<string, unknown>): PermissionScopeValidationResult {
  const unknown = rejectUnknownFields(scope, ['scope', 'commands', 'workingDir', 'maxTimeout']);
  if (unknown) return unknown;
  const sanitized: Record<string, unknown> = {};
  const labelError = copyScopeLabel(scope, sanitized);
  if (labelError) return labelError;

  if ('commands' in scope) {
    const commands = validateNonEmptyStringArray(scope.commands, 'commands', {
      maxItems: 100,
      maxLength: 4096,
    });
    if (!Array.isArray(commands)) return commands;
    sanitized.commands = commands;
  }
  if ('workingDir' in scope) {
    if (
      typeof scope.workingDir !== 'string' ||
      scope.workingDir.length === 0 ||
      scope.workingDir.length > 4096
    ) {
      return { valid: false, error: 'scope.workingDir must be a non-empty string' };
    }
    sanitized.workingDir = scope.workingDir;
  }
  if ('maxTimeout' in scope) {
    if (
      typeof scope.maxTimeout !== 'number' ||
      !Number.isSafeInteger(scope.maxTimeout) ||
      scope.maxTimeout <= 0
    ) {
      return { valid: false, error: 'scope.maxTimeout must be a positive safe integer' };
    }
    sanitized.maxTimeout = scope.maxTimeout;
  }
  return { valid: true, sanitized };
}

function validateDesktopScope(scope: Record<string, unknown>): PermissionScopeValidationResult {
  const unknown = rejectUnknownFields(scope, ['scope', 'features']);
  if (unknown) return unknown;
  const sanitized: Record<string, unknown> = {};
  const labelError = copyScopeLabel(scope, sanitized);
  if (labelError) return labelError;

  if ('features' in scope) {
    const features = validateNonEmptyStringArray(scope.features, 'features', {
      maxItems: VALID_DESKTOP_FEATURES.size,
      maxLength: 32,
    });
    if (!Array.isArray(features)) return features;
    const invalid = features.find((feature) => !VALID_DESKTOP_FEATURES.has(feature));
    if (invalid) return { valid: false, error: `Invalid desktop feature: "${invalid}"` };
    sanitized.features = features;
  }
  return { valid: true, sanitized };
}

export function operationForMethod(method: string): string {
  if (method === 'fs.stat') return 'read';
  const separator = method.indexOf('.');
  return separator === -1 ? method : method.slice(separator + 1);
}

export function desktopFeatureForMethod(
  method: string,
  args: Record<string, unknown> = {},
): string | undefined {
  if (method === 'desktop.cua.call') {
    const tool = args.tool;
    if (typeof tool !== 'string' || tool.length === 0) return undefined;
    const toolMethod = tool.startsWith('desktop.cua.') ? tool : `desktop.cua.${tool}`;
    return DESKTOP_METHOD_FEATURES[toolMethod];
  }
  return DESKTOP_METHOD_FEATURES[method];
}
