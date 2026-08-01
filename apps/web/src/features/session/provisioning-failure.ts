export interface ProvisioningFailurePresentation {
  title: string;
  message: string;
  retryable: boolean;
}

/** Build stable error-card copy from API-owned sandbox failure metadata. */
export function provisioningFailurePresentation(
  metadata: Record<string, unknown>,
  sandboxLabel = 'session',
): ProvisioningFailurePresentation {
  const category =
    typeof metadata.failureCategory === 'string' ? metadata.failureCategory : 'sandbox-provider';
  const message =
    (typeof metadata.errorMessage === 'string' && metadata.errorMessage) ||
    'The sandbox provider could not start this session. Try again.';

  if (category === 'provider-capacity') {
    return { title: 'Sandbox capacity is full', message, retryable: true };
  }

  if (category === 'git-auth') {
    return { title: 'Git access failed', message, retryable: true };
  }

  return { title: `Couldn't start ${sandboxLabel}`, message, retryable: true };
}
