'use client';

// @kortix/sdk/react — the complete Kortix React hook surface. Legacy
// useRuntime* exports remain only as deprecated compatibility aliases while
// the implementation moves to ACP/runtime-neutral hooks.
export * from './runtime';

// ACP session lifecycle and shared runtime error classification.
export {
  classifySendError,
  type KortixSendError,
  type KortixSendErrorKind,
  type SendState,
} from './use-session';
export { useAcpSession, type AcpStoredSessionEnvelope } from './use-acp-session';
export * from './use-composer-capabilities';
export * from './use-models-page';

// The billing/API error classes + helpers, relocated from apps/web's
// `lib/api/errors.ts` (byte-for-byte duplicate of `platform/api/errors.ts`) —
// hosts import the one SDK copy instead of keeping a parallel fork in sync.
export {
  BillingError,
  RequestTooLargeError,
  parseBillingError,
  isBillingError,
  formatBillingErrorForUI,
  type BillingErrorUI,
} from '../core/http/api/errors';

// The kortix-master React Query layer (tasks/tickets/projects/milestones/
// credentials/sandbox-services) relocated from apps/web's six
// `apps/web/src/hooks/{kortix/*,use-sandbox-services}.ts` files — see
// `use-kortix-master.ts` for the full contract, including the injectable
// `KortixMasterIdentity` seam that replaces web's direct `useAuth()` calls.
export * from './use-kortix-master';

// The headless chat kit — `useChatTurns` (memoized `classifyTurn` over a
// message list) + `renderParts` (compile-time-exhaustive part -> T
// dispatcher). Framework-free classification lives in `@kortix/sdk/turns`;
// this is the thin React binding over it. Kept inside the `react` barrel
// rather than a new `@kortix/sdk/react/chat` subpath — no package.json
// exports-map change needed to reach it.
export { useChatTurns, type TurnView, renderParts, type PartRenderers } from './chat';

// Domain hooks — thin React Query bindings over `projects-client` CRUD
// surfaces (secrets, triggers, change requests) that previously had no
// SDK-owned hook (only the client fn). Each owns its own query key + the
// mutations a settings/workbench screen actually needs, with invalidation
// wired so writes reflect without a manual refetch.
export { useProjectSecrets, projectSecretsKey } from './use-project-secrets';
export { useProjectTriggers, projectTriggersKey } from './use-project-triggers';
export { useChangeRequests, changeRequestsKey } from './use-change-requests';
export { useGatewayRoutingPolicy, gatewayRoutingPolicyKey } from './use-gateway-routing-policy';
