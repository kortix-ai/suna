import type {
  ConnectionProfileCredentialInput,
  ConnectorDraftInput,
  OAuth2ClientCredentials,
} from '@kortix/sdk';

export interface OAuth2CredentialForm {
  tokenUrl: string;
  clientId: string;
  authMethod: OAuth2ClientCredentials['token_endpoint_auth_method'];
  clientSecret: string;
  privateKey: string;
  certificateThumbprint: string;
  scopes: string;
  resource: string;
  audience: string;
}

export const EMPTY_OAUTH2_CREDENTIAL_FORM: OAuth2CredentialForm = {
  tokenUrl: '',
  clientId: '',
  authMethod: 'client_secret_post',
  clientSecret: '',
  privateKey: '',
  certificateThumbprint: '',
  scopes: '',
  resource: '',
  audience: '',
};

export function oauth2CredentialFormValid(form: OAuth2CredentialForm): boolean {
  if (!form.tokenUrl.trim() || !form.clientId.trim()) return false;
  return form.authMethod === 'private_key_jwt'
    ? Boolean(form.privateKey.trim() && form.certificateThumbprint.trim())
    : Boolean(form.clientSecret.trim());
}

export function buildOAuth2CredentialInput(
  form: OAuth2CredentialForm,
): ConnectionProfileCredentialInput {
  const oauth2: OAuth2ClientCredentials = {
    type: 'oauth2_client_credentials',
    token_url: form.tokenUrl.trim(),
    client_id: form.clientId.trim(),
    token_endpoint_auth_method: form.authMethod,
  };
  if (form.authMethod === 'private_key_jwt') {
    oauth2.private_key = form.privateKey;
    oauth2.certificate_thumbprint = form.certificateThumbprint.trim();
  } else {
    oauth2.client_secret = form.clientSecret;
  }
  const scopes = form.scopes.split(/\s+/).filter(Boolean);
  if (scopes.length) oauth2.scopes = scopes;
  if (form.resource.trim()) oauth2.resource = form.resource.trim();
  if (form.audience.trim()) oauth2.audience = form.audience.trim();
  return { oauth2 };
}

export async function createConnectorWithOptionalOAuth2(
  projectId: string,
  draft: ConnectorDraftInput,
  oauth2: OAuth2CredentialForm | null,
  deps: {
    createConnector: (projectId: string, draft: ConnectorDraftInput) => Promise<unknown>;
    deleteConnector: (projectId: string, slug: string) => Promise<unknown>;
    setConnectorCredential: (
      projectId: string,
      slug: string,
      credential: ConnectionProfileCredentialInput,
    ) => Promise<unknown>;
  },
): Promise<void> {
  await deps.createConnector(projectId, draft);
  if (!oauth2) return;

  try {
    await deps.setConnectorCredential(projectId, draft.slug, buildOAuth2CredentialInput(oauth2));
  } catch (credentialError) {
    try {
      await deps.deleteConnector(projectId, draft.slug);
    } catch (rollbackError) {
      const credentialMessage =
        credentialError instanceof Error ? credentialError.message : String(credentialError);
      const rollbackMessage =
        rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
      throw new Error(
        `OAuth2 credential validation failed: ${credentialMessage}. Connector rollback failed: ${rollbackMessage}`,
      );
    }
    throw credentialError;
  }
}
