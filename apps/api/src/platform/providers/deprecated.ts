// Daytona support was removed on 2026-10-28. No request, project pin or App
// deploy may choose it, and a stored `daytona` (or `e2b`) row cannot start.
// Pure (no imports) so the session-provider precedence stays importable alone.

export const DEPRECATED_PROVIDER_CODE = 'sandbox_provider_deprecated';
export const DEPRECATED_PROVIDER_ERROR = 'Daytona support was removed. New sandboxes run on Platinum.';

export function isDeprecatedProvider(name: unknown): boolean {
  return name === 'daytona';
}

export const REMOVED_PROVIDER_CODE = 'sandbox_provider_removed';

/**
 * A stored sandbox row names a provider this deployment no longer has code
 * for (`daytona`, `e2b`). The box is unreachable; the session cannot start or
 * resume. http-errors.ts answers it with 410 and REMOVED_PROVIDER_CODE.
 */
export class RemovedProviderError extends Error {
  readonly code = REMOVED_PROVIDER_CODE;
  constructor(readonly provider: string) {
    super(
      provider === 'daytona'
        ? 'Daytona support was removed on 2026-10-28. Start a new session; it runs on Platinum.'
        : `Sandbox provider "${provider}" is no longer supported. Start a new session; it runs on Platinum.`,
    );
    this.name = 'RemovedProviderError';
  }
}
