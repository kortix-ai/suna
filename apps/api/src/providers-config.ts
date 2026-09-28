export type SandboxProviderName = "daytona" | "platinum" | "e2b";
// Recognised provider names. Source-of-truth for what can legally appear in
// ALLOWED_SANDBOX_PROVIDERS — adding a new provider is a one-place change
// here plus a case in `getProvider()` in platform/providers/index.ts.
export const KNOWN_PROVIDERS: readonly SandboxProviderName[] = [
  'daytona',
  'platinum',
  'e2b',
] as const;

/**
 * Parse comma-separated provider list (e.g. "daytona,platinum"). `fallback` is
 * returned both when `raw` is empty and when every entry in it is unrecognised
 * — kept as a parameter (rather than hardcoding `['daytona']`) so a caller
 * whose empty/all-invalid answer should mean "nothing enabled" does not
 * silently inherit ALLOWED_SANDBOX_PROVIDERS' "default to daytona" safety
 * belt.
 */
export function parseAllowedProviders(
  raw: string,
  fallback: SandboxProviderName[] = ['daytona'],
): SandboxProviderName[] {
  if (!raw) return fallback;
  const names = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const valid: SandboxProviderName[] = [];
  for (const n of names) {
    if ((KNOWN_PROVIDERS as readonly string[]).includes(n)) {
      const known = n as SandboxProviderName;
      if (!valid.includes(known)) valid.push(known);
    } else {
      console.warn(
        `[config] Unknown sandbox provider "${n}" in ALLOWED_SANDBOX_PROVIDERS - ignored`,
      );
    }
  }
  return valid.length > 0 ? valid : fallback;
}
