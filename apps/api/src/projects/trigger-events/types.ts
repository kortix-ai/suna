// Provider-agnostic app-event source. One module per provider implements `EventSourceProvider`;
// everything else (reconciler, ingress route) talks to this interface only.

export interface EventSourceConnection {
  connectionId: string;
  connectorSlug: string;
  /** Provider toolkit/app slug. */
  app: string;
  /** `connector_connections.metadata`. */
  metadata: Record<string, unknown>;
}

export interface EventTypeInfo {
  type: string;
  name: string;
  description: string;
  app: string;
  delivery: 'poll' | 'push' | null;
  /** JSON schema of the subscription config. */
  configSchema: Record<string, unknown>;
  /** JSON schema of `event.data`. */
  payloadSchema: Record<string, unknown> | null;
}

/** One normalized inbound event. */
export interface EventDelivery {
  /** Provider subscription id. */
  externalId: string;
  /** Stable per-event id, used as the idempotency key. */
  eventId: string;
  type: string;
  occurredAt: string;
  data: unknown;
}

/** Non-event lifecycle signal from the provider. */
export type ProviderNotice =
  | { kind: 'subscription_disabled'; externalId: string; reason: string }
  | { kind: 'connection_expired'; connectionExternalId: string; reason: string }
  /** A person finished connecting an account: `connectionId` is the Kortix connection it belongs to. */
  | { kind: 'connection_activated'; connectionId: string };

export interface EventApp {
  app: string;
  name: string;
  logo: string | null;
  eventCount: number;
}

export interface EventSourceProvider {
  id: string;
  configured(): boolean;
  ingressConfigured(): boolean;
  listEventTypes(app: string): Promise<EventTypeInfo[]>;
  /** Apps that have at least one event type. */
  listApps(): Promise<EventApp[]>;
  /** True once the shared connection has the provider-side credential `subscribe` needs. Omitted: any active connection counts. */
  connectionReady?(connection: EventSourceConnection): boolean;
  subscribe(input: {
    connection: EventSourceConnection;
    type: string;
    config: Record<string, unknown>;
  }): Promise<{ externalId: string }>;
  /** Idempotent: a provider 404 is success. */
  unsubscribe(externalId: string): Promise<void>;
  /** Throws `EventSignatureError` on a bad signature. */
  receive(input: {
    headers: Headers;
    rawBody: string;
  }): Promise<{ deliveries: EventDelivery[]; notices: ProviderNotice[] }>;
}

export class EventSignatureError extends Error {
  constructor(message = 'Invalid webhook signature') {
    super(message);
    this.name = 'EventSignatureError';
  }
}

/** `subscribe` was given a connection the provider cannot use yet (not authorized). */
export class EventConnectionNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EventConnectionNotReadyError';
  }
}
