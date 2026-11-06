'use client';

export * from './use-prompt-attachments';

// The connector setup-link flow: one phase machine, one link-info cache. The
// host injects the popup opener and browser storage (see ConnectorSetupOptions).
export {
  useConnectorSetup,
  useConnectorLinkInfo,
  type ConnectorSetupOptions,
  type ConnectorSetupPhase,
  type ConnectorPopupOpener,
} from './connector-setup';

// One connector action's output as a cached query, with typed connector errors.
export { useConnectorQuery, type ConnectorQueryOptions } from './use-connector-query';

// The one call a host makes on every identity change (sign-out, a different
// user signing in) to drop the SDK's per-user in-memory session state.
export { resetIdentityState } from './reset-identity-state';

// @kortix/sdk/react — the session runtime React hook surface (every runtime
// hook, query-key factory, provider, and type). This is the single source of
// truth the web UI binds to.
export * from './runtime-hooks';
export { useRuntimeSupports } from './use-runtime-supports';
export { useHasSessionDesktop } from './use-has-session-desktop';
// The session's one live connection (R5.3). `useSession` mounts it; a host that
// runs its own copy of a poll (self-heal, sync) gates it on this.
export { useSessionStreamConnected, useSessionStreamEnded } from './use-session-stream';
export type { SessionStreamEnd, SessionStreamEndReason } from './use-session-stream';

// `useSession`'s reply/error-classification surface — not (yet) re-exported by
// `./runtime-hooks`'s explicit barrel list, so re-exported directly here.
export {
  answerQuestion,
  answerPermission,
  rejectQuestion,
  classifySendError,
  type KortixSendError,
  type KortixSendErrorConnector,
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

// The framework-free SSE event-stream primitive that `useRuntimeEventStream`
// (exported above via `./runtime-hooks`) wraps. Re-exported here too so a host
// already importing from `@kortix/sdk/react` can build its own binding
// (e.g. a non-QueryClient consumer) without a second import from `@kortix/sdk`.
export {
  openEventStream,
  type EventStreamClient,
  type EventStreamConnectionState,
  type EventStreamHandle,
  type EventStreamTimers,
  type RuntimeEvent,
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
// (yet) re-exported by `./runtime-hooks`'s explicit barrel list, so re-exported
// directly here (same reasoning as the other direct re-exports above).
export {
  useSessionSend,
  beginOptimisticSend,
  markOptimisticSendDispatched,
  markOptimisticSendInboxBacked,
  abandonOptimisticSend,
  recoverFromSendFailure,
  sendAndRecover,
  sendWithReceipt,
  stopWithReceipt,
  STOP_HOLD_DEADLINE_MS,
  applyOptimisticAbort,
  replayStartStash,
  type RuntimeMessagesClient,
  type SendWithReceiptArgs,
  type StopWithReceiptOptions,
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
// dispatcher). Framework-free classification lives in `@kortix/sdk`;
// this is the thin React binding over it. Kept inside the `react` barrel
// rather than a new `@kortix/sdk/react/chat` subpath — no package.json
// exports-map change needed to reach it.
export { useChatTurns, type TurnView, renderParts, type PartRenderers } from './chat';

// Domain hooks — thin React Query bindings over `projects-client` CRUD
// surfaces (secrets, triggers, change requests) that previously had no
// SDK-owned hook (only the client fn). Each owns its own query key + the
// mutations a settings/workbench screen actually needs, with invalidation
// wired so writes reflect without a manual refetch.
// The two lists every host opens on. Both had a client fn and a `qk` key and
// no hook, so each host rewrote the useQuery wiring — including a TUI key
// (`['tui','accounts',…]`) that shared nothing with the rest of the cache.
export {
  useAccounts,
  useProjects,
  accountsQueryOptions,
  projectsQueryOptions,
  type AccountsKey,
  type ProjectsKey,
  type UseAccountsOptions,
  type UseProjectsOptions,
} from './use-accounts';
// The workspace names. Same queries and keys as useAccounts/useProjects.
export {
  useWorkspaces,
  useWorkspace,
  workspacesState,
  workspaceQueryOptions,
  type UseWorkspacesOptions,
  type UseWorkspacesResult,
  type UseWorkspaceOptions,
} from './use-workspaces';
export { useWorkspaceSecrets, useProjectSecrets, workspaceSecretsKey, projectSecretsKey } from './use-project-secrets';
export { useAccountSecretResources, useSessionProviderSecretPools, useSubscriptionUsage, useSubscriptionConnections } from './use-provider-secrets';
export {
  useWorkspaceTriggers, useProjectTriggers,
  workspaceTriggersKey, projectTriggersKey,
  useWorkspaceTriggerEventTypes, useProjectTriggerEventTypes,
  useWorkspaceTriggerEventApps, useProjectTriggerEventApps,
  workspaceTriggerEventAppsKey, projectTriggerEventAppsKey,
  workspaceTriggerEventTypesKey, projectTriggerEventTypesKey,
  useTriggerRuns,
  useWorkspaceTriggerRuns, useProjectTriggerRuns,
  triggerRunsKey,
  workspaceTriggerRunsKey, projectTriggerRunsKey,
  type TriggerRunsQueryOptions,
} from './use-project-triggers';
export { useWorkspaceReminders, useProjectReminders, useSessionReminders } from './use-reminders';
export { useUnifiedTriggers } from './use-unified-triggers';
export {
  runWorkspaceGoalControl, runProjectGoalControl,
  useWorkspaceGoal, useProjectGoal,
  useWorkspaceGoalControl, useProjectGoalControl,
  useWorkspaceGoalEvents, useProjectGoalEvents,
  useWorkspaceGoalFiles, useProjectGoalFiles,
  useWorkspaceGoals, useProjectGoals,
  useSessionGoal,
  type ProjectGoalControlInput, type WorkspaceGoalControlInput,
} from './use-goals';
export { useRoom, useRoomConversations, useRoomMessages, useRoomThread, useRooms, useSpaceRoom } from './use-rooms';
export { usePeerMessages, useReachableAgents, useSessionWorkflows, useTeamTasks, useTeammates } from './use-multi-agent';
export { prefetchArtifact, useArtifact, useArtifactMutations, useArtifactText, useArtifactTypes, useArtifactVersions, useArtifacts } from './use-artifacts';
export {
  useApproveCaptureDevice,
  useApproveCaptureEnrollment,
  useCaptureChunkMedia,
  useCaptureDays,
  useCaptureDeviceGrant,
  useCaptureDevices,
  useCaptureEnrollments,
  useCaptureEnrollmentTokens,
  useCapturePolicy,
  useCaptureSearch,
  useCaptureStorage,
  useCaptureTimeline,
  useCaptureTimelineItems,
  useCaptureWorkspace,
  useCreateCaptureEnrollmentToken,
  useDenyCaptureDevice,
  useDenyCaptureEnrollment,
  useLinkCaptureDevice,
  useRevokeCaptureDevice,
  useRevokeCaptureEnrollmentToken,
  useSetCaptureEnabled,
  useSetCapturePolicy,
  useSetCaptureStorage,
} from './use-capture';
export { useSessionMessageAuthors } from './use-session-message-authors';
export { useSessionModelUsage } from './use-session-model-usage';
export { useSessionUsage } from './use-session-usage';
export { useChangeRequests, changeRequestsKey } from './use-change-requests';
export { useGatewayRoutingPolicy, gatewayRoutingPolicyKey } from './use-gateway-routing-policy';
export {
  useWorkspaceApps, useProjectApps,
  useAppDeployments,
  useAppDeployment,
  useAppMachines,
  useAppVolumes,
  useAppVolumeSnapshots,
  appMachinesKey,
  appVolumesKey,
  useAppAccess,
  workspaceAppsKey, projectAppsKey,
  appDeploymentsKey,
  appDeploymentKey,
  useAppEvents,
  useSendAppTestEvent,
  appEventsKey,
} from './use-project-apps';

export * from './use-admin-accounts';
export * from './use-admin-credit-codes';
export * from './use-admin-role';
export * from './use-admin-projects';
export * from './use-admin-activity-analytics';
export * from './use-ops-overview';
export * from './use-billing-plan';
export * from './use-impersonation';
export * from './use-teams-installations';
export * from './use-tunnel';
export * from './use-chrome-connections';
export * from './use-admin-sandboxes';
export * from './use-authenticated-preview-url';
export * from './use-static-file-preview';
export * from './run-pty-command';
export * from './runtime-actions';

// The client-cache-unification `qk` key factory (rooted at `'kx'`, disjoint
// from `kortixKeys`'s `'kortix'` root above) + its four freshness tiers, the
// single `useProjectName` accessor, and the invalidation/optimistic-write
// helpers that keep the projects-list and project-detail caches in sync. See
// `query-keys.ts` for why the root segment is `'kx'` and not `'kortix'`.
// The client-side authorization probe — relocated from `apps/web/src/lib/`
// (`use-permission.ts` + `use-project-can.ts`), where it violated the "logic
// lives in the SDK" rule and left every other host with no probe at all.
// `invalidatePermissionProbes` is the cache contract every assignment write
// must honour: a 5-minute stale verdict is a revoke that has not happened yet.
export {
  useCan,
  useCans,
  usePermissionsFor,
  invalidatePermissionProbes,
  permissionProbeKey,
  permissionProbeBatchKey,
  type CanResult,
  type CanTarget,
  type CanOptions,
} from './use-can';

export * from './query-keys';
// Workspace file/git cache keys. The event stream invalidates these on
// `file.edited` and at turn end, so a host's file hooks must key on them.
export { fileContentKeys, binaryBlobKeys, fileListKeys, gitStatusKeys } from './file-keys';
export * from './query-contracts';
export * from './use-project-name';
export * from './use-project-session';
export * from './use-session-participants';
export * from './use-project-sessions';
export {
  useAddWorkspaceSpaceLink, useAddProjectSpaceLink,
  useAddWorkspaceSpaceMembers, useAddProjectSpaceMembers,
  useChannelsOnboarding,
  useJoinWorkspaceSpace, useJoinProjectSpace,
  useLeaveWorkspaceSpace, useLeaveProjectSpace,
  useWorkspaceSpaceMembers, useProjectSpaceMembers,
  useRemoveWorkspaceSpaceMember, useRemoveProjectSpaceMember,
  useCreateWorkspaceSpace, useCreateProjectSpace,
  useMarkChannelsOnboarding,
  useOpenWorkspaceDm, useOpenProjectDm,
  usePinWorkspaceSpaceLink, usePinProjectSpaceLink,
  useWorkspaceSpaceApps, useProjectSpaceApps,
  useWorkspaceSpaceGeneralNotice, useProjectSpaceGeneralNotice,
  usePrivateChannelsAvailable,
  usePrivateChannelsNotIn,
  useWorkspaceSpaceLinks, useProjectSpaceLinks,
  useWorkspaceSpaces, useProjectSpaces,
  useRemoveWorkspaceSpaceLink, useRemoveProjectSpaceLink,
  useSetWorkspaceSpaceTabs, useSetProjectSpaceTabs,
  useUpdateWorkspaceSpace, useUpdateProjectSpace,
  useWorkspaceSpaceProactive, useProjectSpaceProactive,
  useSetWorkspaceSpaceProactive, useSetProjectSpaceProactive,
} from './use-project-spaces';
// Session groups (`session_groups`): the project's shared folders of sessions.
export {
  useCreateWorkspaceSessionGroup, useCreateProjectSessionGroup,
  useDeleteWorkspaceSessionGroup, useDeleteProjectSessionGroup,
  useWorkspaceSessionGroups, useProjectSessionGroups,
  useRenameWorkspaceSessionGroup, useRenameProjectSessionGroup,
  useReorderWorkspaceSessionGroups, useReorderProjectSessionGroups,
  useSetWorkspaceSessionGroup, useSetProjectSessionGroup,
} from './use-session-groups';
export * from './use-sessions-needing-input';
export * from './use-session-asks';
// The review inbox: needs-you counts for badges, and the paged list (KRTX-2316).
export * from './use-review-summary';
// The caller's notification inbox, preferences and session watch (KRTX-1742).
export * from './use-notifications';
export * from './use-session-list-state';
export * from './session-cache-write';
export * from './invalidate-project';
export * from './use-feature-flag';
export * from './use-project-memory';
export * from './use-project-search';
export * from './use-project-files';

// "Sign in with Kortix" — the browser half of `createKortixAuth`
// (`@kortix/sdk/server`): the viewer hook and the sign-in link.
export {
  useKortixViewer,
  fetchKortixViewer,
  SignInWithKortix,
  kortixSignInHref,
  kortixSignOutHref,
  KORTIX_AUTH_DEFAULT_BASE_PATH,
  type KortixViewerInfo,
  type KortixViewerState,
  type SignInWithKortixProps,
} from './sign-in-with-kortix';

// Kortix Apps — the viewer of a Kortix-hosted App (no login of its own).
// Kept across the runtime-client revert; no runtime-client dependency.
export {
  useKortixAppViewer,
  type KortixAppViewerState,
} from './use-kortix-app-viewer';

export { useModelAccess } from './use-model-access';
export { useCustomLlmProviders } from './use-custom-llm-providers';

// The sandbox-image load state: the SDK owns the raw-file URL, the HEAD probe,
// the auth headers, the size gate, the probe cache and the one fresh-token
// retry; the host binds the sandbox origin and the native image events.
// The size-gate helpers stay module-local: no host consumes them (the tests
// import the module directly), so the public surface carries only the hook
// and the formatter the hosts render sizes with.
export { formatMegabytes, useSandboxImage } from './use-sandbox-image';

export {
  GATEWAY_LOGS_PAGE_SIZE,
  useGatewayOverview,
  useGatewaySeries,
  useGatewayBreakdown,
  useGatewaySessions,
  useGatewayErrors,
  useGatewayLogs,
  useGatewayLogFacets,
  useGatewayLog,
  useGatewayBudgets,
  useSetGatewayBudget,
  useDeleteGatewayBudget,
  useGatewayKeys,
  useCreateGatewayKey,
  useRevokeGatewayKey,
} from './use-project-gateway';

export * from './use-admin-providers';
