// Daytona is deprecated. It keeps operating the sandboxes that already exist,
// but no request, project pin or App deploy may choose it for a new one.
// Pure (no imports) so the session-provider precedence stays importable alone.

export const DEPRECATED_PROVIDER_CODE = 'sandbox_provider_deprecated';
export const DEPRECATED_PROVIDER_ERROR = 'Daytona is deprecated. New sandboxes run on Platinum.';

export function isDeprecatedProvider(name: unknown): boolean {
  return name === 'daytona';
}
