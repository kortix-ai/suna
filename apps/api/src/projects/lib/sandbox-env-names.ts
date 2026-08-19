// Imported, not restated. `kortix validate` has to refuse exactly what deploy
// refuses — when the two lists drifted, a manifest setting `KORTIX_API_KEY`
// validated clean and then failed at deploy, and the App that shipped without
// those variables did not error at all: the feature that needed them simply
// rendered nothing. One list, in the contract package both sides depend on.
import { RESERVED_ENV_NAMES } from '@kortix/manifest-schema';

const RESERVED_SANDBOX_ENV_NAMES = RESERVED_ENV_NAMES;

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

export function isSandboxSecretEnvNameAllowed(name: string): boolean {
  return !NEVER_IN_SANDBOX.has(name) && !isReservedSandboxEnvName(name);
}

export function sanitizeSandboxEnv(env: Record<string, string>): {
  env: Record<string, string>;
  names: string[];
} {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (!isSandboxSecretEnvNameAllowed(name)) continue;
    out[name] = value;
  }
  return { env: out, names: Object.keys(out).sort() };
}

export { RESERVED_SANDBOX_ENV_NAMES };
