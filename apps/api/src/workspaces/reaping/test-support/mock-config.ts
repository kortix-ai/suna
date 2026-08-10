/**
 * A COMPLETE stand-in for the `config` module, for use with `mock.module`.
 *
 * `mock.module` in bun is process-global and replaces the module wholesale, so a
 * factory returning `{ config: {...} }` deletes every other named export for
 * every suite in the same process. `src/config.ts` also exports `SANDBOX_VERSION`,
 * `KNOWN_PROVIDERS`, `parseAllowedProviders`, `KORTIX_MARKUP`,
 * `PLATFORM_FEE_MARKUP`, and `getToolCost` — and `src/snapshots/hash.ts` imports
 * `SANDBOX_VERSION`, which is the exact break that made
 * `bun test src/projects/reaping/` unrunnable.
 *
 * Importing the real module here is not an option: it validates env at import
 * time and rejects dotenvx ciphertext outside `dotenvx run`.
 */
export function mockConfigModule(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    config: {
      KORTIX_SANDBOX_AUTOSTOP_MINUTES: 15,
      ALLOWED_SANDBOX_PROVIDERS: ['daytona'],
      ...overrides,
    },
    SANDBOX_VERSION: 'test',
    KNOWN_PROVIDERS: ['daytona', 'platinum', 'e2b'],
    // Same arity as the real `(raw, fallback = ['daytona'])`. A zero-arg stub
    // silently ignores both arguments, so a suite that comes to depend on the
    // fallback would pass here and behave differently against real config.
    parseAllowedProviders: (raw: string, fallback: string[] = ['daytona']) =>
      raw ? raw.split(',').map((p) => p.trim()).filter(Boolean) : fallback,
    KORTIX_MARKUP: 1.2,
    PLATFORM_FEE_MARKUP: 0.1,
    getToolCost: () => 0,
  };
}
