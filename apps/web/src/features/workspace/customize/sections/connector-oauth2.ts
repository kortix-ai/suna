import type {
  ConnectionCredentialInput,
  ConnectorDraftInput,
  OAuth2ApplicationInput,
  OAuth2ClientCredentials,
  OAuth2TokenEndpointAuthMethod,
} from '@kortix/sdk';

import { connectorSyncErrorForSlug, createOnlyConnectorDraft } from './connector-connection-form';

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
  if (form.authMethod === 'none') return true;
  if (form.authMethod === 'private_key_jwt') return Boolean(form.privateKey.trim());
  return Boolean(form.clientSecret.trim());
}

export function buildOAuth2CredentialInput(
  form: OAuth2CredentialForm,
): ConnectionCredentialInput {
  const oauth2: OAuth2ClientCredentials = {
    type: 'oauth2_client_credentials',
    token_url: form.tokenUrl.trim(),
    client_id: form.clientId.trim(),
    token_endpoint_auth_method: form.authMethod,
  };
  if (form.authMethod === 'private_key_jwt') {
    oauth2.private_key = form.privateKey;
    if (form.certificateThumbprint.trim()) {
      oauth2.certificate_thumbprint = form.certificateThumbprint.trim();
    }
  } else if (form.authMethod !== 'none') {
    oauth2.client_secret = form.clientSecret;
  }
  const scopes = form.scopes.split(/\s+/).filter(Boolean);
  if (scopes.length) oauth2.scopes = scopes;
  if (form.resource.trim()) oauth2.resource = form.resource.trim();
  if (form.audience.trim()) oauth2.audience = form.audience.trim();
  return { oauth2 };
}

export type OAuth2Grant = 'client_credentials' | 'authorization_code' | 'device_authorization';

export interface OAuth2ApplicationForm {
  grant: OAuth2Grant;
  discoveryUrl: string;
  authorizationUrl: string;
  tokenUrl: string;
  deviceAuthorizationUrl: string;
  revocationUrl: string;
  clientId: string;
  authMethod: OAuth2TokenEndpointAuthMethod;
  clientSecret: string;
  privateKey: string;
  scopes: string;
  resource: string;
  audience: string;
}

export const EMPTY_OAUTH2_APPLICATION_FORM: OAuth2ApplicationForm = {
  grant: 'client_credentials',
  discoveryUrl: '',
  authorizationUrl: '',
  tokenUrl: '',
  deviceAuthorizationUrl: '',
  revocationUrl: '',
  clientId: '',
  authMethod: 'client_secret_post',
  clientSecret: '',
  privateKey: '',
  scopes: '',
  resource: '',
  audience: '',
};

function splitScopes(scopes: string): string[] {
  return scopes.split(/\s+/).filter(Boolean);
}

export function oauth2ApplicationFormValid(form: OAuth2ApplicationForm): boolean {
  if (!form.clientId.trim()) return false;
  if (!form.discoveryUrl.trim() && !form.tokenUrl.trim()) return false;
  if (
    form.grant === 'authorization_code' &&
    !form.discoveryUrl.trim() &&
    !form.authorizationUrl.trim()
  ) {
    return false;
  }
  if (
    form.grant === 'device_authorization' &&
    !form.discoveryUrl.trim() &&
    !form.deviceAuthorizationUrl.trim()
  ) {
    return false;
  }
  if (form.authMethod === 'none') return true;
  if (form.authMethod === 'private_key_jwt') return Boolean(form.privateKey.trim());
  return Boolean(form.clientSecret.trim());
}

export function buildOAuth2ApplicationInput(form: OAuth2ApplicationForm): OAuth2ApplicationInput {
  const input: OAuth2ApplicationInput = {
    client_id: form.clientId.trim(),
    token_endpoint_auth_method: form.authMethod,
  };
  if (form.discoveryUrl.trim()) input.discovery_url = form.discoveryUrl.trim();
  if (form.authorizationUrl.trim()) input.authorization_url = form.authorizationUrl.trim();
  if (form.tokenUrl.trim()) input.token_url = form.tokenUrl.trim();
  if (form.deviceAuthorizationUrl.trim()) {
    input.device_authorization_url = form.deviceAuthorizationUrl.trim();
  }
  if (form.revocationUrl.trim()) input.revocation_url = form.revocationUrl.trim();
  if (form.authMethod === 'private_key_jwt') input.private_key = form.privateKey;
  else if (form.authMethod !== 'none') input.client_secret = form.clientSecret;
  const scopes = splitScopes(form.scopes);
  if (scopes.length) input.scopes = scopes;
  if (form.resource.trim()) input.resource = form.resource.trim();
  if (form.audience.trim()) input.audience = form.audience.trim();
  return input;
}

export function mergeOAuth2DiscoveryMetadata(
  form: OAuth2ApplicationForm,
  metadata: Partial<OAuth2ApplicationInput>,
): OAuth2ApplicationForm {
  return {
    ...form,
    authorizationUrl: form.authorizationUrl || metadata.authorization_url || '',
    tokenUrl: form.tokenUrl || metadata.token_url || '',
    deviceAuthorizationUrl: form.deviceAuthorizationUrl || metadata.device_authorization_url || '',
    revocationUrl: form.revocationUrl || metadata.revocation_url || '',
    scopes: form.scopes || metadata.scopes?.join(' ') || '',
  };
}

export async function createConnectorWithOptionalOAuth2(
  projectId: string,
  draft: ConnectorDraftInput,
  oauth2: OAuth2CredentialForm | null,
  deps: {
    createConnector: (
      projectId: string,
      draft: ConnectorDraftInput,
    ) => Promise<Awaited<ReturnType<typeof import('@kortix/sdk').createConnector>>>;
    deleteConnector: (projectId: string, slug: string) => Promise<unknown>;
    setConnectorCredential: (
      projectId: string,
      slug: string,
      credential: ConnectionCredentialInput,
    ) => Promise<unknown>;
  },
): Promise<{ syncError: string | null; credentialStored: boolean }> {
  const created = await deps.createConnector(projectId, createOnlyConnectorDraft(draft));
  const syncError = connectorSyncErrorForSlug(created, draft.slug);
  if (syncError) return { syncError, credentialStored: false };
  if (!oauth2) return { syncError: null, credentialStored: false };

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
  return { syncError: null, credentialStored: true };
}
