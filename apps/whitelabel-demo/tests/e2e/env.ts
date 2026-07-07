/** Shared constants for the wrapper-mode boots across test files. */

export const WRAPPER_KEY = 'test-wrapper-key';
export const SESSION_SECRET = 'test-session-secret-do-not-use-in-prod';
export const DEMO_PASSWORD = 'demo-pass-xyz-1';
export const COST_MARKUP = '1.5';

export function wrapperEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    KORTIX_API_KEY: WRAPPER_KEY,
    SESSION_SECRET,
    DEMO_PASSWORD,
    COST_MARKUP,
    RATE_LIMIT_PER_MIN: '100000', // effectively unlimited unless a test overrides it
    NEXT_PUBLIC_KORTIX_API_URL: 'https://unused-in-wrapper-mode.example/v1',
    ...overrides,
  };
}
