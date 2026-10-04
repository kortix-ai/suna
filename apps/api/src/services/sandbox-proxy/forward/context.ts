import type { ProvisionTimeline } from '../../platform/services/provision-timeline';
import type { SandboxTurnIdentity } from '../../sessions/session-turn-ledger';
import type { SandboxRecord, resolveSandboxIngress } from '../backend';
import type { ProxyHop } from '../proxy-hop';
import type { PreviewProxyAccess } from './access';
import type { TurnLifecycle } from './turn-start';

/** One proxied request, fixed once the pre-flight gates have passed. */
export interface ForwardRequest {
  sandboxId: string;
  port: number;
  access: PreviewProxyAccess;
  method: string;
  remainingPath: string;
  queryString: string;
  incomingHeaders: Headers;
  origin: string;
  redirectPrefix: string;
  publicOrigin: string | undefined;
  originMode: boolean | undefined;
  ptl: ProvisionTimeline;
  record: SandboxRecord;
  userId: string;
  ingressRequest: { port: number; path: string; transport: 'http' };
  upstreamPort: number;
  sandboxAuthored: boolean;
  promptDelivery: boolean;
  serviceKey: SandboxRecord['serviceKey'];
  isSseEventStreamRequest: boolean;
  prefetchedIngress: ReturnType<typeof resolveSandboxIngress> | null;
  promptDedupeKey: string | null;
  turnIdentity: SandboxTurnIdentity | null;
  turn: TurnLifecycle;
}

/** What the retry loop learns across attempts. Each field's meaning is documented where `forwardWithRetry` initializes it. */
export interface ForwardState {
  requestBody: ArrayBuffer | undefined;
  effectiveMessageId: string | null;
  wakeTriggered: boolean;
  sawDeadSignal: boolean;
  promptDeliveryMayHaveReachedUpstream: boolean;
  sawLongTurnTimeout: boolean;
  promptDeliveryMaybeAccepted: boolean;
  lastAttemptHop: ProxyHop;
  providerCredentialsRefreshed: boolean;
}
