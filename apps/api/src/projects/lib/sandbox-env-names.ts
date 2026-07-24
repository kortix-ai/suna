const RESERVED_SANDBOX_ENV_NAMES = new Set([
  'PORT', 'PATH', 'HOME', 'PWD', 'USER', 'LOGNAME', 'SHELL', 'HOSTNAME',
  'TERM', 'TMPDIR', 'NODE_ENV', 'NODE_OPTIONS', 'LD_PRELOAD', 'LD_LIBRARY_PATH',
]);

// Secrets the sandbox must NEVER see, even though the platform holds them.
// Boot (buildSessionSandboxEnvVars) deletes SLACK_BOT_TOKEN explicitly to keep
// the raw bot token away from a prompt-injectable agent (KORTIX-206). The
// hot-push path (resolveSandboxEnvSnapshot → sanitizeSandboxEnv) scrubs THIS
// set, so SLACK_BOT_TOKEN must be here too or a live env re-sync would re-inject
// what boot withheld.
const NEVER_IN_SANDBOX = new Set([
  'SLACK_SIGNING_SECRET',
  'SLACK_BOT_TOKEN',
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
