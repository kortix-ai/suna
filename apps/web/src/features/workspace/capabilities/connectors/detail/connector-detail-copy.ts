import type {
  AdminConnector,
  ConnectorAuthorizationStrategy,
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

const MANAGED_PROVIDERS = new Set<AdminConnector['provider']>(['composio', 'pipedream']);

type ConnectorReadinessInput = Pick<
  AdminConnector,
  'provider' | 'status' | 'authorizationStrategy' | 'authSecret' | 'secretSet'
>;

export function connectorConnectionIsReady(
  connector: ConnectorReadinessInput,
  hasStrategyConnection: boolean,
): boolean {
  if (connector.status !== 'active') return false;
  if (connector.provider === 'composio') return hasStrategyConnection;
  if (!connector.authSecret) return true;
  if (connector.authorizationStrategy === 'user') return hasStrategyConnection;
  return connector.secretSet;
}

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
    const cta = input.authorizationStrategy === 'project' ? 'Connect' : 'Add my own';
    return [
      {
        title: `Click ${cta}`,
        description: `The ${cta} button above opens the provider’s own sign-in window.`,
      },
      {
        title: 'Approve OAuth access',
        description: 'Sign in to the provider and approve the requested account or workspace.',
      },
      {
        title: 'Check the account under Accounts',
        description: `You land back on this page. The account appears in the Accounts tab below, and ${access} reports Connected.`,
      },
    ];
  }

  const target = input.provider === 'mcp' ? 'MCP endpoint' : 'API endpoint';
  const credentialSource =
    input.provider === 'mcp'
      ? 'The server URL comes from the provider’s docs — see Documentation below.'
      : 'Create it in the app’s developer or API settings — see Documentation below.';
  return [
    {
      title: 'Review the endpoint',
      description: `Open the Accounts tab below and confirm the ${target}, transport, and authentication method.`,
    },
    {
      // The step names the button as it is labelled — the page's primary CTA
      // says Connect, and the dialog it opens names the specific credential.
      title: 'Click Connect',
      description:
        input.provider === 'mcp'
          ? `Servers that support OAuth 2.0 connect in one click — no key to create. Otherwise, paste the token. ${credentialSource}`
          : `${credentialSource} Kortix stores the ${credentialLabel(input.requestAuthType)} encrypted and sends it with every request — agents never see it.`,
    },
    {
      title: 'Verify the connection',
      description:
        'The status above reports Connected. Then open the Tools tab and choose what agents may call.',
    },
  ];
}

/**
 * Which of an app's published surfaces to lead with.
 *
 * MCP wins whenever it is addable (COR-17): its auth chain — OAuth discovery
 * plus RFC 7591 dynamic client registration — connects in one click on
 * servers that support it, which no other surface kind can offer. A surface
 * without a `connector` template cannot be added from here at all, so it
 * never wins over one that can. Falls back to the first addable surface,
 * then the first surface, preserving feed order.
 */
export function recommendedSurfaceVariant<
  V extends { kind: string; connector: unknown | null },
>(variants: readonly V[]): V | null {
  return (
    variants.find((variant) => variant.kind === 'mcp' && variant.connector) ??
    variants.find((variant) => variant.connector) ??
    variants[0] ??
    null
  );
}

/**
 * The full surface list with the recommended one first — a stable move-to-
 * front, so everything else keeps its feed order.
 */
export function surfacesRecommendedFirst<
  V extends { kind: string; connector: unknown | null },
>(variants: readonly V[]): V[] {
  const recommended = recommendedSurfaceVariant(variants);
  if (!recommended) return [...variants];
  return [recommended, ...variants.filter((variant) => variant !== recommended)];
}
