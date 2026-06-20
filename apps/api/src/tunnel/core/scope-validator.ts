const VALID_CAPABILITIES = new Set<string>([
  'filesystem',
  'shell',
  'desktop',
]);

const VALID_FS_OPERATIONS = new Set(['read', 'write', 'list', 'delete']);
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

export interface ScopeValidationResult {
  valid: boolean;
  error?: string;
  sanitized?: Record<string, unknown>;
}

export function isValidCapability(capability: string): boolean {
  return VALID_CAPABILITIES.has(capability);
}

export function validateScope(
  capability: string,
  scope: Record<string, unknown>,
): ScopeValidationResult {
  if (!scope || typeof scope !== 'object') {
    return { valid: false, error: 'Scope must be an object' };
  }

  if (Object.keys(scope).length === 0) {
    return { valid: true, sanitized: {} };
  }

  switch (capability) {
    case 'filesystem':
      return validateFilesystemScope(scope);
    case 'shell':
      return validateShellScope(scope);
    case 'desktop':
      return validateDesktopScope(scope);
    default:
      return { valid: false, error: `Unknown capability: ${capability}` };
  }
}

function validateFilesystemScope(scope: Record<string, unknown>): ScopeValidationResult {
  const sanitized: Record<string, unknown> = {};

  if ('paths' in scope) {
    if (!Array.isArray(scope.paths) || !scope.paths.every((p) => typeof p === 'string')) {
      return { valid: false, error: 'scope.paths must be an array of strings' };
    }
    sanitized.paths = scope.paths;
  }

  if ('operations' in scope) {
    if (!Array.isArray(scope.operations) || !scope.operations.every((o) => typeof o === 'string')) {
      return { valid: false, error: 'scope.operations must be an array of strings' };
    }
    for (const op of scope.operations) {
      if (!VALID_FS_OPERATIONS.has(op as string)) {
        return { valid: false, error: `Invalid filesystem operation: "${op}"` };
      }
    }
    sanitized.operations = scope.operations;
  }

  if ('excludePatterns' in scope) {
    if (!Array.isArray(scope.excludePatterns) || !scope.excludePatterns.every((p) => typeof p === 'string')) {
      return { valid: false, error: 'scope.excludePatterns must be an array of strings' };
    }
    sanitized.excludePatterns = scope.excludePatterns;
  }

  if ('maxFileSize' in scope) {
    if (typeof scope.maxFileSize !== 'number' || scope.maxFileSize <= 0) {
      return { valid: false, error: 'scope.maxFileSize must be a positive number' };
    }
    sanitized.maxFileSize = scope.maxFileSize;
  }

  return { valid: true, sanitized };
}

function validateShellScope(scope: Record<string, unknown>): ScopeValidationResult {
  const sanitized: Record<string, unknown> = {};

  if ('commands' in scope) {
    if (!Array.isArray(scope.commands) || !scope.commands.every((c) => typeof c === 'string')) {
      return { valid: false, error: 'scope.commands must be an array of strings' };
    }
    sanitized.commands = scope.commands;
  }

  if ('workingDir' in scope) {
    if (typeof scope.workingDir !== 'string') {
      return { valid: false, error: 'scope.workingDir must be a string' };
    }
    sanitized.workingDir = scope.workingDir;
  }

  if ('maxTimeout' in scope) {
    if (typeof scope.maxTimeout !== 'number' || scope.maxTimeout <= 0) {
      return { valid: false, error: 'scope.maxTimeout must be a positive number' };
    }
    sanitized.maxTimeout = scope.maxTimeout;
  }

  return { valid: true, sanitized };
}

function validateDesktopScope(scope: Record<string, unknown>): ScopeValidationResult {
  const sanitized: Record<string, unknown> = {};

  if ('features' in scope) {
    if (!Array.isArray(scope.features) || !scope.features.every((f) => typeof f === 'string')) {
      return { valid: false, error: 'scope.features must be an array of strings' };
    }
    for (const feature of scope.features) {
      if (!VALID_DESKTOP_FEATURES.has(feature as string)) {
        return { valid: false, error: `Invalid desktop feature: "${feature}"` };
      }
    }
    sanitized.features = scope.features;
  }

  return { valid: true, sanitized };
}
