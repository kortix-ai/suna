export interface ConnectorSecretBindingValidationInput {
  secretIdentifier: string | null;
  requiresAuth: boolean;
  provider: string;
  authorizationStrategy: 'project' | 'user';
  hasStoredCredential: boolean;
  secretCompatible: boolean;
}

export interface ConnectorSecretBindingValidationError {
  error: string;
  status: 409;
}

export function validateConnectorSecretBinding(
  input: ConnectorSecretBindingValidationInput,
): ConnectorSecretBindingValidationError | null {
  if (input.secretIdentifier === null) return null;
  if (!input.requiresAuth || input.provider === 'channel') {
    return {
      error: 'This connector does not accept a project secret credential',
      status: 409,
    };
  }
  if (input.authorizationStrategy !== 'project') {
    return {
      error: 'Project secrets require a project authorization strategy',
      status: 409,
    };
  }
  if (input.hasStoredCredential) {
    return {
      error: 'Disconnect the stored connector credential before binding a project secret',
      status: 409,
    };
  }
  if (!input.secretCompatible) {
    return {
      error: 'Secret must be active and use Kortix service delivery for a connector',
      status: 409,
    };
  }
  return null;
}
