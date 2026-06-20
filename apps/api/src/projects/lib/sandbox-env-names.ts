const RESERVED_SANDBOX_ENV_NAMES = new Set([
  'PORT', 'PATH', 'HOME', 'PWD', 'USER', 'LOGNAME', 'SHELL', 'HOSTNAME',
  'TERM', 'TMPDIR', 'NODE_ENV', 'NODE_OPTIONS', 'LD_PRELOAD', 'LD_LIBRARY_PATH',
]);

const NEVER_IN_SANDBOX = new Set([
  'SLACK_SIGNING_SECRET',
]);

export function isReservedSandboxEnvName(name: string): boolean {
  return (
    RESERVED_SANDBOX_ENV_NAMES.has(name) ||
    name.startsWith('KORTIX_') ||
    name.startsWith('OPENCODE_')
  );
}

export function sanitizeSandboxEnv(env: Record<string, string>): {
  env: Record<string, string>;
  names: string[];
} {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (NEVER_IN_SANDBOX.has(name)) continue;
    if (isReservedSandboxEnvName(name)) continue;
    out[name] = value;
  }
  return { env: out, names: Object.keys(out).sort() };
}

export { RESERVED_SANDBOX_ENV_NAMES };
