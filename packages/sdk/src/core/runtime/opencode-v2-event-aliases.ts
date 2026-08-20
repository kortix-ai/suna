/**
 * Back-compat aliases for the `V2Event*` type names @opencode-ai/sdk exported
 * up to 1.17.x. The 1.18.x generator dropped the `V2` prefix and exports the
 * same event types as `Event*`. These names are part of @kortix/sdk's public
 * type surface (public-type-surface.snapshot.json), so removing them is a
 * breaking change — keep them until the next major.
 */
/** @deprecated Renamed upstream in @opencode-ai/sdk 1.18 — use `EventCatalogUpdated`. */
export type { EventCatalogUpdated as V2EventCatalogUpdated } from '@opencode-ai/sdk/v2/client';
/** @deprecated Renamed upstream in @opencode-ai/sdk 1.18 — use `EventCommandExecuted`. */
export type { EventCommandExecuted as V2EventCommandExecuted } from '@opencode-ai/sdk/v2/client';
/** @deprecated Renamed upstream in @opencode-ai/sdk 1.18 — use `EventFileEdited`. */
export type { EventFileEdited as V2EventFileEdited } from '@opencode-ai/sdk/v2/client';
/** @deprecated Renamed upstream in @opencode-ai/sdk 1.18 — use `EventFileWatcherUpdated`. */
export type { EventFileWatcherUpdated as V2EventFileWatcherUpdated } from '@opencode-ai/sdk/v2/client';
/** @deprecated Renamed upstream in @opencode-ai/sdk 1.18 — use `EventGlobalDisposed`. */
export type { EventGlobalDisposed as V2EventGlobalDisposed } from '@opencode-ai/sdk/v2/client';
/** @deprecated Renamed upstream in @opencode-ai/sdk 1.18 — use `EventInstallationUpdateAvailable`. */
export type { EventInstallationUpdateAvailable as V2EventInstallationUpdateAvailable } from '@opencode-ai/sdk/v2/client';
/** @deprecated Renamed upstream in @opencode-ai/sdk 1.18 — use `EventInstallationUpdated`. */
export type { EventInstallationUpdated as V2EventInstallationUpdated } from '@opencode-ai/sdk/v2/client';
/** @deprecated Renamed upstream in @opencode-ai/sdk 1.18 — use `EventIntegrationConnectionUpdated`. */
export type { EventIntegrationConnectionUpdated as V2EventIntegrationConnectionUpdated } from '@opencode-ai/sdk/v2/client';
/** @deprecated Renamed upstream in @opencode-ai/sdk 1.18 — use `EventIntegrationUpdated`. */
export type { EventIntegrationUpdated as V2EventIntegrationUpdated } from '@opencode-ai/sdk/v2/client';
/** @deprecated Renamed upstream in @opencode-ai/sdk 1.18 — use `EventLspUpdated`. */
export type { EventLspUpdated as V2EventLspUpdated } from '@opencode-ai/sdk/v2/client';
/** @deprecated Renamed upstream in @opencode-ai/sdk 1.18 — use `EventMcpBrowserOpenFailed`. */
export type { EventMcpBrowserOpenFailed as V2EventMcpBrowserOpenFailed } from '@opencode-ai/sdk/v2/client';
/** @deprecated Renamed upstream in @opencode-ai/sdk 1.18 — use `EventMcpToolsChanged`. */
export type { EventMcpToolsChanged as V2EventMcpToolsChanged } from '@opencode-ai/sdk/v2/client';
/** @deprecated Renamed upstream in @opencode-ai/sdk 1.18 — use `EventMessagePartDelta`. */
export type { EventMessagePartDelta as V2EventMessagePartDelta } from '@opencode-ai/sdk/v2/client';
/** @deprecated Renamed upstream in @opencode-ai/sdk 1.18 — use `EventMessagePartRemoved`. */
export type { EventMessagePartRemoved as V2EventMessagePartRemoved } from '@opencode-ai/sdk/v2/client';
/** @deprecated Renamed upstream in @opencode-ai/sdk 1.18 — use `EventMessagePartUpdated`. */
export type { EventMessagePartUpdated as V2EventMessagePartUpdated } from '@opencode-ai/sdk/v2/client';
/** @deprecated Renamed upstream in @opencode-ai/sdk 1.18 — use `EventMessageRemoved`. */
export type { EventMessageRemoved as V2EventMessageRemoved } from '@opencode-ai/sdk/v2/client';
/** @deprecated Renamed upstream in @opencode-ai/sdk 1.18 — use `EventMessageUpdated`. */
export type { EventMessageUpdated as V2EventMessageUpdated } from '@opencode-ai/sdk/v2/client';
/** @deprecated Renamed upstream in @opencode-ai/sdk 1.18 — use `EventModelsDevRefreshed`. */
export type { EventModelsDevRefreshed as V2EventModelsDevRefreshed } from '@opencode-ai/sdk/v2/client';
/** @deprecated Renamed upstream in @opencode-ai/sdk 1.18 — use `EventPermissionAsked`. */
export type { EventPermissionAsked as V2EventPermissionAsked } from '@opencode-ai/sdk/v2/client';
/** @deprecated Renamed upstream in @opencode-ai/sdk 1.18 — use `EventPermissionReplied`. */
export type { EventPermissionReplied as V2EventPermissionReplied } from '@opencode-ai/sdk/v2/client';
/** @deprecated Renamed upstream in @opencode-ai/sdk 1.18 — use `EventPermissionV2Asked`. */
export type { EventPermissionV2Asked as V2EventPermissionV2Asked } from '@opencode-ai/sdk/v2/client';
/** @deprecated Renamed upstream in @opencode-ai/sdk 1.18 — use `EventPermissionV2Replied`. */
export type { EventPermissionV2Replied as V2EventPermissionV2Replied } from '@opencode-ai/sdk/v2/client';
/** @deprecated Renamed upstream in @opencode-ai/sdk 1.18 — use `EventPluginAdded`. */
export type { EventPluginAdded as V2EventPluginAdded } from '@opencode-ai/sdk/v2/client';
/** @deprecated Renamed upstream in @opencode-ai/sdk 1.18 — use `EventProjectDirectoriesUpdated`. */
export type { EventProjectDirectoriesUpdated as V2EventProjectDirectoriesUpdated } from '@opencode-ai/sdk/v2/client';
/** @deprecated Renamed upstream in @opencode-ai/sdk 1.18 — use `EventProjectUpdated`. */
export type { EventProjectUpdated as V2EventProjectUpdated } from '@opencode-ai/sdk/v2/client';
/** @deprecated Renamed upstream in @opencode-ai/sdk 1.18 — use `EventPtyCreated`. */
export type { EventPtyCreated as V2EventPtyCreated } from '@opencode-ai/sdk/v2/client';
/** @deprecated Renamed upstream in @opencode-ai/sdk 1.18 — use `EventPtyDeleted`. */
export type { EventPtyDeleted as V2EventPtyDeleted } from '@opencode-ai/sdk/v2/client';
/** @deprecated Renamed upstream in @opencode-ai/sdk 1.18 — use `EventPtyExited`. */
export type { EventPtyExited as V2EventPtyExited } from '@opencode-ai/sdk/v2/client';
/** @deprecated Renamed upstream in @opencode-ai/sdk 1.18 — use `EventPtyUpdated`. */
export type { EventPtyUpdated as V2EventPtyUpdated } from '@opencode-ai/sdk/v2/client';
/** @deprecated Renamed upstream in @opencode-ai/sdk 1.18 — use `EventQuestionAsked`. */
export type { EventQuestionAsked as V2EventQuestionAsked } from '@opencode-ai/sdk/v2/client';
/** @deprecated Renamed upstream in @opencode-ai/sdk 1.18 — use `EventQuestionRejected`. */
export type { EventQuestionRejected as V2EventQuestionRejected } from '@opencode-ai/sdk/v2/client';
/** @deprecated Renamed upstream in @opencode-ai/sdk 1.18 — use `EventQuestionReplied`. */
export type { EventQuestionReplied as V2EventQuestionReplied } from '@opencode-ai/sdk/v2/client';
/** @deprecated Renamed upstream in @opencode-ai/sdk 1.18 — use `EventQuestionV2Asked`. */
export type { EventQuestionV2Asked as V2EventQuestionV2Asked } from '@opencode-ai/sdk/v2/client';
/** @deprecated Renamed upstream in @opencode-ai/sdk 1.18 — use `EventQuestionV2Rejected`. */
export type { EventQuestionV2Rejected as V2EventQuestionV2Rejected } from '@opencode-ai/sdk/v2/client';
/** @deprecated Renamed upstream in @opencode-ai/sdk 1.18 — use `EventQuestionV2Replied`. */
export type { EventQuestionV2Replied as V2EventQuestionV2Replied } from '@opencode-ai/sdk/v2/client';
/** @deprecated Renamed upstream in @opencode-ai/sdk 1.18 — use `EventReferenceUpdated`. */
export type { EventReferenceUpdated as V2EventReferenceUpdated } from '@opencode-ai/sdk/v2/client';
/** @deprecated Renamed upstream in @opencode-ai/sdk 1.18 — use `EventServerConnected`. */
export type { EventServerConnected as V2EventServerConnected } from '@opencode-ai/sdk/v2/client';
/** @deprecated Renamed upstream in @opencode-ai/sdk 1.18 — use `EventSessionCompacted`. */
export type { EventSessionCompacted as V2EventSessionCompacted } from '@opencode-ai/sdk/v2/client';
/** @deprecated Renamed upstream in @opencode-ai/sdk 1.18 — use `EventSessionCreated`. */
export type { EventSessionCreated as V2EventSessionCreated } from '@opencode-ai/sdk/v2/client';
/** @deprecated Renamed upstream in @opencode-ai/sdk 1.18 — use `EventSessionDeleted`. */
export type { EventSessionDeleted as V2EventSessionDeleted } from '@opencode-ai/sdk/v2/client';
/** @deprecated Renamed upstream in @opencode-ai/sdk 1.18 — use `EventSessionDiff`. */
export type { EventSessionDiff as V2EventSessionDiff } from '@opencode-ai/sdk/v2/client';
/** @deprecated Renamed upstream in @opencode-ai/sdk 1.18 — use `EventSessionError`. */
export type { EventSessionError as V2EventSessionError } from '@opencode-ai/sdk/v2/client';
/** @deprecated Renamed upstream in @opencode-ai/sdk 1.18 — use `EventSessionIdle`. */
export type { EventSessionIdle as V2EventSessionIdle } from '@opencode-ai/sdk/v2/client';
/** @deprecated Renamed upstream in @opencode-ai/sdk 1.18 — use `EventSessionNextAgentSwitched`. */
export type { EventSessionNextAgentSwitched as V2EventSessionNextAgentSwitched } from '@opencode-ai/sdk/v2/client';
/** @deprecated Renamed upstream in @opencode-ai/sdk 1.18 — use `EventSessionNextCompactionDelta`. */
export type { EventSessionNextCompactionDelta as V2EventSessionNextCompactionDelta } from '@opencode-ai/sdk/v2/client';
/** @deprecated Renamed upstream in @opencode-ai/sdk 1.18 — use `EventSessionNextCompactionEnded`. */
export type { EventSessionNextCompactionEnded as V2EventSessionNextCompactionEnded } from '@opencode-ai/sdk/v2/client';
/** @deprecated Renamed upstream in @opencode-ai/sdk 1.18 — use `EventSessionNextCompactionStarted`. */
export type { EventSessionNextCompactionStarted as V2EventSessionNextCompactionStarted } from '@opencode-ai/sdk/v2/client';
/** @deprecated Renamed upstream in @opencode-ai/sdk 1.18 — use `EventSessionNextContextUpdated`. */
export type { EventSessionNextContextUpdated as V2EventSessionNextContextUpdated } from '@opencode-ai/sdk/v2/client';
/** @deprecated Renamed upstream in @opencode-ai/sdk 1.18 — use `EventSessionNextModelSwitched`. */
export type { EventSessionNextModelSwitched as V2EventSessionNextModelSwitched } from '@opencode-ai/sdk/v2/client';
/** @deprecated Renamed upstream in @opencode-ai/sdk 1.18 — use `EventSessionNextMoved`. */
export type { EventSessionNextMoved as V2EventSessionNextMoved } from '@opencode-ai/sdk/v2/client';
/** @deprecated Renamed upstream in @opencode-ai/sdk 1.18 — use `EventSessionNextPromptAdmitted`. */
export type { EventSessionNextPromptAdmitted as V2EventSessionNextPromptAdmitted } from '@opencode-ai/sdk/v2/client';
/** @deprecated Renamed upstream in @opencode-ai/sdk 1.18 — use `EventSessionNextPrompted`. */
export type { EventSessionNextPrompted as V2EventSessionNextPrompted } from '@opencode-ai/sdk/v2/client';
/** @deprecated Renamed upstream in @opencode-ai/sdk 1.18 — use `EventSessionNextReasoningDelta`. */
export type { EventSessionNextReasoningDelta as V2EventSessionNextReasoningDelta } from '@opencode-ai/sdk/v2/client';
/** @deprecated Renamed upstream in @opencode-ai/sdk 1.18 — use `EventSessionNextReasoningEnded`. */
export type { EventSessionNextReasoningEnded as V2EventSessionNextReasoningEnded } from '@opencode-ai/sdk/v2/client';
/** @deprecated Renamed upstream in @opencode-ai/sdk 1.18 — use `EventSessionNextReasoningStarted`. */
export type { EventSessionNextReasoningStarted as V2EventSessionNextReasoningStarted } from '@opencode-ai/sdk/v2/client';
/** @deprecated Renamed upstream in @opencode-ai/sdk 1.18 — use `EventSessionNextRetried`. */
export type { EventSessionNextRetried as V2EventSessionNextRetried } from '@opencode-ai/sdk/v2/client';
/** @deprecated Renamed upstream in @opencode-ai/sdk 1.18 — use `EventSessionNextRevertCleared`. */
export type { EventSessionNextRevertCleared as V2EventSessionNextRevertCleared } from '@opencode-ai/sdk/v2/client';
/** @deprecated Renamed upstream in @opencode-ai/sdk 1.18 — use `EventSessionNextRevertCommitted`. */
export type { EventSessionNextRevertCommitted as V2EventSessionNextRevertCommitted } from '@opencode-ai/sdk/v2/client';
/** @deprecated Renamed upstream in @opencode-ai/sdk 1.18 — use `EventSessionNextRevertStaged`. */
export type { EventSessionNextRevertStaged as V2EventSessionNextRevertStaged } from '@opencode-ai/sdk/v2/client';
/** @deprecated Renamed upstream in @opencode-ai/sdk 1.18 — use `EventSessionNextShellEnded`. */
export type { EventSessionNextShellEnded as V2EventSessionNextShellEnded } from '@opencode-ai/sdk/v2/client';
/** @deprecated Renamed upstream in @opencode-ai/sdk 1.18 — use `EventSessionNextShellStarted`. */
export type { EventSessionNextShellStarted as V2EventSessionNextShellStarted } from '@opencode-ai/sdk/v2/client';
/** @deprecated Renamed upstream in @opencode-ai/sdk 1.18 — use `EventSessionNextStepEnded`. */
export type { EventSessionNextStepEnded as V2EventSessionNextStepEnded } from '@opencode-ai/sdk/v2/client';
/** @deprecated Renamed upstream in @opencode-ai/sdk 1.18 — use `EventSessionNextStepFailed`. */
export type { EventSessionNextStepFailed as V2EventSessionNextStepFailed } from '@opencode-ai/sdk/v2/client';
/** @deprecated Renamed upstream in @opencode-ai/sdk 1.18 — use `EventSessionNextStepStarted`. */
export type { EventSessionNextStepStarted as V2EventSessionNextStepStarted } from '@opencode-ai/sdk/v2/client';
/** @deprecated Renamed upstream in @opencode-ai/sdk 1.18 — use `EventSessionNextSynthetic`. */
export type { EventSessionNextSynthetic as V2EventSessionNextSynthetic } from '@opencode-ai/sdk/v2/client';
/** @deprecated Renamed upstream in @opencode-ai/sdk 1.18 — use `EventSessionNextTextDelta`. */
export type { EventSessionNextTextDelta as V2EventSessionNextTextDelta } from '@opencode-ai/sdk/v2/client';
/** @deprecated Renamed upstream in @opencode-ai/sdk 1.18 — use `EventSessionNextTextEnded`. */
export type { EventSessionNextTextEnded as V2EventSessionNextTextEnded } from '@opencode-ai/sdk/v2/client';
/** @deprecated Renamed upstream in @opencode-ai/sdk 1.18 — use `EventSessionNextTextStarted`. */
export type { EventSessionNextTextStarted as V2EventSessionNextTextStarted } from '@opencode-ai/sdk/v2/client';
/** @deprecated Renamed upstream in @opencode-ai/sdk 1.18 — use `EventSessionNextToolCalled`. */
export type { EventSessionNextToolCalled as V2EventSessionNextToolCalled } from '@opencode-ai/sdk/v2/client';
/** @deprecated Renamed upstream in @opencode-ai/sdk 1.18 — use `EventSessionNextToolFailed`. */
export type { EventSessionNextToolFailed as V2EventSessionNextToolFailed } from '@opencode-ai/sdk/v2/client';
/** @deprecated Renamed upstream in @opencode-ai/sdk 1.18 — use `EventSessionNextToolInputDelta`. */
export type { EventSessionNextToolInputDelta as V2EventSessionNextToolInputDelta } from '@opencode-ai/sdk/v2/client';
/** @deprecated Renamed upstream in @opencode-ai/sdk 1.18 — use `EventSessionNextToolInputEnded`. */
export type { EventSessionNextToolInputEnded as V2EventSessionNextToolInputEnded } from '@opencode-ai/sdk/v2/client';
/** @deprecated Renamed upstream in @opencode-ai/sdk 1.18 — use `EventSessionNextToolInputStarted`. */
export type { EventSessionNextToolInputStarted as V2EventSessionNextToolInputStarted } from '@opencode-ai/sdk/v2/client';
/** @deprecated Renamed upstream in @opencode-ai/sdk 1.18 — use `EventSessionNextToolProgress`. */
export type { EventSessionNextToolProgress as V2EventSessionNextToolProgress } from '@opencode-ai/sdk/v2/client';
/** @deprecated Renamed upstream in @opencode-ai/sdk 1.18 — use `EventSessionNextToolSuccess`. */
export type { EventSessionNextToolSuccess as V2EventSessionNextToolSuccess } from '@opencode-ai/sdk/v2/client';
/** @deprecated Renamed upstream in @opencode-ai/sdk 1.18 — use `EventSessionStatus`. */
export type { EventSessionStatus as V2EventSessionStatus } from '@opencode-ai/sdk/v2/client';
/** @deprecated Renamed upstream in @opencode-ai/sdk 1.18 — use `EventSessionUpdated`. */
export type { EventSessionUpdated as V2EventSessionUpdated } from '@opencode-ai/sdk/v2/client';
/** @deprecated Renamed upstream in @opencode-ai/sdk 1.18 — use `EventTodoUpdated`. */
export type { EventTodoUpdated as V2EventTodoUpdated } from '@opencode-ai/sdk/v2/client';
/** @deprecated Renamed upstream in @opencode-ai/sdk 1.18 — use `EventTuiCommandExecute`. */
export type { EventTuiCommandExecute as V2EventTuiCommandExecute } from '@opencode-ai/sdk/v2/client';
/** @deprecated Renamed upstream in @opencode-ai/sdk 1.18 — use `EventTuiPromptAppend`. */
export type { EventTuiPromptAppend as V2EventTuiPromptAppend } from '@opencode-ai/sdk/v2/client';
/** @deprecated Renamed upstream in @opencode-ai/sdk 1.18 — use `EventTuiSessionSelect`. */
export type { EventTuiSessionSelect as V2EventTuiSessionSelect } from '@opencode-ai/sdk/v2/client';
/** @deprecated Renamed upstream in @opencode-ai/sdk 1.18 — use `EventTuiToastShow`. */
export type { EventTuiToastShow as V2EventTuiToastShow } from '@opencode-ai/sdk/v2/client';
/** @deprecated Renamed upstream in @opencode-ai/sdk 1.18 — use `EventVcsBranchUpdated`. */
export type { EventVcsBranchUpdated as V2EventVcsBranchUpdated } from '@opencode-ai/sdk/v2/client';
/** @deprecated Renamed upstream in @opencode-ai/sdk 1.18 — use `EventWorkspaceFailed`. */
export type { EventWorkspaceFailed as V2EventWorkspaceFailed } from '@opencode-ai/sdk/v2/client';
/** @deprecated Renamed upstream in @opencode-ai/sdk 1.18 — use `EventWorkspaceReady`. */
export type { EventWorkspaceReady as V2EventWorkspaceReady } from '@opencode-ai/sdk/v2/client';
/** @deprecated Renamed upstream in @opencode-ai/sdk 1.18 — use `EventWorkspaceStatus`. */
export type { EventWorkspaceStatus as V2EventWorkspaceStatus } from '@opencode-ai/sdk/v2/client';
/** @deprecated Renamed upstream in @opencode-ai/sdk 1.18 — use `EventWorktreeFailed`. */
export type { EventWorktreeFailed as V2EventWorktreeFailed } from '@opencode-ai/sdk/v2/client';
/** @deprecated Renamed upstream in @opencode-ai/sdk 1.18 — use `EventWorktreeReady`. */
export type { EventWorktreeReady as V2EventWorktreeReady } from '@opencode-ai/sdk/v2/client';
