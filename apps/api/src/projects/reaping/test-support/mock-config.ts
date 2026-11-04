import * as realConfig from '../../../config';

/** Preserve config exports while overriding settings for reaping tests. */
export function mockConfigModule(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    ...realConfig,
    config: {
      KORTIX_SANDBOX_AUTOSTOP_MINUTES: 15,
      ALLOWED_SANDBOX_PROVIDERS: ['daytona'],
      ...overrides,
    },
    SANDBOX_VERSION: 'test',
    KNOWN_PROVIDERS: ['platinum', 'daytona'],
    // Same arity as the real `(raw, fallback = ['platinum'])`. A zero-arg stub
    // silently ignores both arguments, so a suite that comes to depend on the
    // fallback would pass here and behave differently against real config.
    parseAllowedProviders: (raw: string, fallback: string[] = ['platinum']) =>
      raw ? raw.split(',').map((p) => p.trim()).filter(Boolean) : fallback,
    PLATFORM_FEE_MARKUP: 0.1,
    getToolCost: () => 0,
  };
}
