/**
 * Thin client for a self-hosted Kortix WhatsApp Gateway.
 *
 * The gateway is deployed by the operator (https://github.com/kortix-ai/whatsapp-gateway),
 * so its base URL is per-install rather than a fixed vendor endpoint. Calls run
 * server-side: the browser never holds the gateway API key.
 */

export class WhatsAppGatewayError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'WhatsAppGatewayError';
    this.status = status;
  }
}

export interface WhatsAppGatewayConnection {
  id: string;
  displayName: string;
  phoneNumber: string | null;
  status: string;
}

const TIMEOUT_MS = 15_000;

/** Reject anything that is not a plain absolute http(s) URL. */
export function normalizeGatewayUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new WhatsAppGatewayError('Gateway URL must be a valid URL', 400);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new WhatsAppGatewayError('Gateway URL must use http or https', 400);
  }
  if (url.username || url.password) {
    throw new WhatsAppGatewayError('Gateway URL must not contain credentials', 400);
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

async function gatewayFetch<T>(
  gatewayUrl: string,
  apiKey: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${gatewayUrl}${path}`, {
      ...init,
      headers: {
        'x-api-key': apiKey,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...init.headers,
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new WhatsAppGatewayError('Could not reach the WhatsApp gateway at that URL', 502);
  }

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }

  if (!response.ok) {
    const message =
      payload && typeof payload === 'object' && 'message' in payload
        ? String((payload as { message: unknown }).message)
        : `Gateway returned ${response.status}`;
    throw new WhatsAppGatewayError(
      response.status === 401 || response.status === 403
        ? 'The gateway rejected that API key'
        : message,
      response.status === 401 || response.status === 403 ? 401 : 502,
    );
  }
  return payload as T;
}

/** Connections (phone numbers) the supplied key can reach. */
export async function listGatewayConnections(
  gatewayUrl: string,
  apiKey: string,
): Promise<WhatsAppGatewayConnection[]> {
  const body = await gatewayFetch<{ data?: WhatsAppGatewayConnection[] }>(
    gatewayUrl,
    apiKey,
    '/v1/accounts',
  );
  return body.data ?? [];
}

/**
 * Register a webhook endpoint on the gateway pointing back at this Kortix
 * instance, scoped to one connection. The signing secret is returned once.
 */
export async function createGatewayWebhook(
  gatewayUrl: string,
  apiKey: string,
  input: { url: string; accountId: string; description?: string },
): Promise<{ id: string; secret: string }> {
  return gatewayFetch<{ id: string; secret: string }>(gatewayUrl, apiKey, '/v1/webhook-endpoints', {
    method: 'POST',
    body: JSON.stringify({
      url: input.url,
      description: input.description ?? 'Kortix',
      // Empty event_types subscribes to all current and future events.
      event_types: [],
      account_ids: [input.accountId],
    }),
  });
}

export async function deleteGatewayWebhook(
  gatewayUrl: string,
  apiKey: string,
  endpointId: string,
): Promise<void> {
  try {
    await gatewayFetch(gatewayUrl, apiKey, `/v1/webhook-endpoints/${endpointId}`, {
      method: 'DELETE',
    });
  } catch {
    // Disconnecting locally must succeed even if the gateway is unreachable or
    // the endpoint was already removed there.
  }
}
