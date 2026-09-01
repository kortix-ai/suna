import type {
  AdminConnector,
  ConnectorAuthorizationStrategy,
  ConnectorConfig,
  ConnectorRequestAuthType,
} from '@kortix/sdk';

export interface ConnectorSetupStep {
  title: string;
  description: string;
}

interface ConnectorSetupInput {
  provider: AdminConnector['provider'];
  authorizationStrategy: ConnectorAuthorizationStrategy;
  connected: boolean;
  requestAuthType?: ConnectorRequestAuthType | 'oauth2' | null;
}

export interface ConnectorTechnicalRow {
  label: string;
  value: string;
}

type ConnectorTechnicalInput = Pick<
  ConnectorConfig,
  'transport' | 'endpoint' | 'url' | 'baseUrl' | 'auth' | 'authorizationStrategy' | 'headers'
>;

const MANAGED_PROVIDERS = new Set<AdminConnector['provider']>(['composio', 'pipedream']);

function credentialLabel(type: ConnectorSetupInput['requestAuthType']): string {
  switch (type) {
    case 'bearer':
      return 'Bearer credential';
    case 'basic':
      return 'Basic authentication credential';
    case 'api_key':
      return 'API key';
    case 'hmac':
      return 'HMAC credential';
    case 'aws_sigv4':
      return 'AWS Signature Version 4 credential';
    case 'mtls':
      return 'mutual TLS credential';
    case 'oauth1':
      return 'OAuth 1.0 credential';
    case 'oauth2':
      return 'OAuth credential';
    case 'none':
      return 'no credential';
    default:
      return 'required credential';
  }
}

export function connectorSetupSteps(input: ConnectorSetupInput): ConnectorSetupStep[] {
  const access =
    input.authorizationStrategy === 'project'
      ? 'the shared project account'
      : 'your account for private sessions';

  if (input.connected) {
    return [
      {
        title: 'Review the active account',
        description: `Confirm that ${access} is the account you intend to use.`,
      },
      {
        title: 'Review tool access',
        description: 'Check which connector tools can read data, change data, or require approval.',
      },
      {
        title: 'Use the connector',
        description: 'Start a session and grant the agent this connector when the task needs it.',
      },
    ];
  }

  if (MANAGED_PROVIDERS.has(input.provider)) {
    return [
      {
        title: 'Start the connection',
        description: 'Open the provider authorization flow from Kortix.',
      },
      {
        title: 'Approve OAuth access',
        description: 'Sign in to the provider and approve the requested account or workspace.',
      },
      {
        title: 'Verify the project connection',
        description: 'Return to Kortix and confirm that the shared account reports Connected.',
      },
    ];
  }

  const target = input.provider === 'mcp' ? 'MCP endpoint' : 'API endpoint';
  return [
    {
      title: 'Review the endpoint',
      description: `Confirm the ${target}, transport, and authentication method.`,
    },
    {
      title: 'Add authentication',
      description: `Store the ${credentialLabel(input.requestAuthType)} that Kortix sends with requests.`,
    },
    {
      title: 'Verify the connection',
      description: 'Confirm that the connector reports Connected, then review its available tools.',
    },
  ];
}

function authenticationLabel(type: ConnectorRequestAuthType): string {
  const labels: Record<ConnectorRequestAuthType, string> = {
    none: 'None',
    bearer: 'Bearer token',
    basic: 'Basic authentication',
    custom: 'Custom credential',
    api_key: 'API key',
    oauth1: 'OAuth 1.0',
    hmac: 'HMAC signature',
    aws_sigv4: 'AWS Signature Version 4',
    mtls: 'Mutual TLS',
  };
  return labels[type];
}

function credentialLocation(config: ConnectorTechnicalInput): string | null {
  if (config.auth.type === 'none') return null;
  const location =
    config.auth.in === 'header'
      ? 'Request header'
      : config.auth.in === 'query'
        ? 'Query parameter'
        : 'Cookie';
  return config.auth.name ? `${location} · ${config.auth.name}` : location;
}

export function connectorTechnicalRows(config: ConnectorTechnicalInput): ConnectorTechnicalRow[] {
  const rows: ConnectorTechnicalRow[] = [];
  if (config.transport) rows.push({ label: 'Transport', value: config.transport.toUpperCase() });

  const endpoint = config.endpoint ?? config.url ?? config.baseUrl;
  if (endpoint) rows.push({ label: 'Endpoint', value: endpoint });

  rows.push({ label: 'Authentication', value: authenticationLabel(config.auth.type) });
  const location = credentialLocation(config);
  if (location) rows.push({ label: 'Credential location', value: location });

  rows.push({
    label: 'Access',
    value:
      config.authorizationStrategy === 'project'
        ? 'Project · one shared connection'
        : 'Each member · separate connection',
  });

  const headers = Object.keys(config.headers);
  if (headers.length > 0) rows.push({ label: 'Request headers', value: headers.join(', ') });
  return rows;
}
