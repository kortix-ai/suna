'use client';

// @kortix/sdk/react — the complete OpenCode React hook surface, relocated
// verbatim from apps/web (every useOpenCode* hook, query-key factory, provider,
// and type). This is the single source of truth the web UI binds to.
export * from './opencode';

// `useSession`'s reply/error-classification surface — not (yet) re-exported by
// `./opencode`'s explicit barrel list, so re-exported directly here.
export {
  answerQuestion,
  answerPermission,
  rejectQuestion,
  classifySendError,
  type KortixSendError,
  type KortixSendErrorKind,
  type SendState,
} from './use-session';

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

// The framework-free SSE event-stream primitive that `useOpenCodeEventStream`
// (exported above via `./opencode`) wraps. Re-exported here too so a host
// already importing from `@kortix/sdk/react` can build its own binding
// (e.g. a non-QueryClient consumer) without a second import from
// `@kortix/sdk/event-stream`.
export {
  openEventStream,
  type EventStreamClient,
  type EventStreamHandle,
  type EventStreamTimers,
  type OpenCodeEvent,
  type OpenEventStreamOptions,
} from '../core/stream/event-stream';

// The kortix-master React Query layer (tasks/tickets/projects/milestones/
// credentials/sandbox-services) relocated from apps/web's six
// `apps/web/src/hooks/{kortix/*,use-sandbox-services}.ts` files — see
// `use-kortix-master.ts` for the full contract, including the injectable
// `KortixMasterIdentity` seam that replaces web's direct `useAuth()` calls.
export * from './use-kortix-master';

// The send / stash-replay / error-recovery core extracted from apps/web's
// `session-chat.tsx` — see `use-session-send.ts` for the full contract. Not
// (yet) re-exported by `./opencode`'s explicit barrel list, so re-exported
// directly here (same reasoning as the other direct re-exports above).
export {
  useSessionSend,
  beginOptimisticSend,
  abandonOptimisticSend,
  recoverFromSendFailure,
  sendAndRecover,
  applyOptimisticAbort,
  replayStartStash,
  type OpenCodeMessagesClient,
  type SendRecoveryOptions,
  type SendAndRecoverArgs,
  type SendAndRecoverResult,
  type StashReplayTimerHandle,
  type StashReplayTimers,
  type PreparedStashSend,
  type StartStashReplayOptions,
  type StartStashReplayHandle,
  type UseSessionSendOptions,
  type SendCallOptions,
  type UseSessionSendResult,
} from './use-session-send';

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
