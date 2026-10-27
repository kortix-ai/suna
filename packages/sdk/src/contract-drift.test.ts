/**
 * The SDK's REST types against `@kortix/api-contract`, the zod schemas
 * apps/api builds its responses through, for the routes every session view
 * reads. Checked by `pnpm --filter @kortix/sdk typecheck` (the packages lane);
 * `bun test` only proves the file loads.
 *
 * Two directions, per type:
 *  - `fits<Sdk>(contract)`: everything the server sends fits the SDK type. A
 *    field the SDK declares narrower than the wire (`string` where the server
 *    sends `null`) fails here.
 *  - `noPhantom`: every key the SDK declares is a key the server sends. A key
 *    the server never sends fails here unless it is listed as a known
 *    deprecated leftover.
 *
 * The SDK never imports the contract at runtime (zod stays out of its bundle),
 * and this file is outside every entry point's import graph.
 */
import { expect, test } from 'bun:test';
import type * as C from '../../api-contract/src/index';
import type * as SL from '../../api-contract/src/session-log';
import type { SessionLogPage } from './core/session-log/source';
import type { KortixAccount } from './core/rest/projects-client/accounts';
import type { ChangeRequest } from './core/rest/projects-client/change-requests';
import type { KortixProject } from './core/rest/projects-client/projects';
import type { SessionStartResult } from './core/rest/projects-client/session-sandbox';
import type {
  AddProjectMemoryNoteInput,
  CreateProjectMemoryPageInput,
  ProjectMemoryDeleteResult,
  ProjectMemoryLayer,
  ProjectMemoryPage,
  ProjectMemoryPageSummary,
  ProjectMemorySearchInput,
  ProjectMemorySearchResult,
  ProjectMemoryVersionList,
  SessionMemoryUsage,
  UpdateProjectMemoryPageInput,
} from './core/rest/projects-client/memory';
import type {
  ChannelsOnboarding,
  ChannelsOnboardingMark,
  ProjectSpace,
  ProjectSpaceGeneralNotice,
  ProjectSpaceLink,
} from './core/rest/projects-client/spaces';
import type {
  CreateSessionPromptResult,
  ProjectSession,
  SessionAuditAction,
  SessionOpenBundle,
  SessionPrompt,
  SessionTranscript,
  SessionTranscriptMessage,
  SessionTranscriptSyncEnvelope,
  SessionTurn,
  SessionTurnEnded,
  SessionTurnFailure,
  SessionTurnStatus,
  WarmProjectSessionResult,
} from './core/rest/projects-client/sessions';
import type {
  ProjectTrigger,
  ProjectTriggerDryRunResult,
  ProjectTriggerListing,
  ProjectTriggerRun,
  ProjectTriggerRunList,
} from './core/rest/projects-client/triggers';
import type { CaptureSearchHit, CaptureSearchResult, CaptureWorkspace } from './core/rest/platform-client/capture';

declare function fits<Sdk>(contract: Sdk): void;
/** A parsed JSON body: `readonly` in a server-side type does not reach the wire. */
type Json<T> = T extends readonly (infer U)[]
  ? Json<U>[]
  : T extends object
    ? { -readonly [K in keyof T]: Json<T[K]> }
    : T;
declare const wire: <T>() => Json<T>;
type NoPhantom<Sdk, Contract, Deprecated extends PropertyKey = never> = Exclude<
  keyof Sdk,
  keyof Contract | Deprecated
>;
declare function noPhantom<Keys extends never>(): void;

/** Never called: the body is checked by `tsc`. */
export function contractDrift(): void {
  fits<KortixProject>(wire<C.Project>());
  // `warm_pool*` are read by older hosts only; the API stopped sending them.
  noPhantom<NoPhantom<KortixProject, C.Project, 'warm_pool' | 'warm_pool_available'>>();

  fits<ProjectSession>(wire<C.ProjectSession>());
  noPhantom<NoPhantom<ProjectSession, C.ProjectSession>>();

  fits<ProjectSpace>(wire<C.Space>());
  noPhantom<NoPhantom<ProjectSpace, C.Space>>();

  fits<ProjectSpaceLink>(wire<C.SpaceLink>());
  noPhantom<NoPhantom<ProjectSpaceLink, C.SpaceLink>>();
  // The fetched title and icon: the SDK declares every field the Links tab reads.
  noPhantom<NoPhantom<C.SpaceLink, ProjectSpaceLink>>();
  fits<ProjectSpaceGeneralNotice>(wire<NonNullable<C.SpaceList['general_notice']>>());
  noPhantom<NoPhantom<ProjectSpaceGeneralNotice, C.SpaceGeneralNotice>>();
  fits<ChannelsOnboarding>(wire<C.ChannelsOnboarding>());
  noPhantom<NoPhantom<ChannelsOnboarding, C.ChannelsOnboarding>>();
  noPhantom<NoPhantom<ChannelsOnboarding['get_started'], C.ChannelsOnboarding['get_started']>>();
  fits<C.ChannelsOnboardingMark>(wire<ChannelsOnboardingMark>());
  fits<ChannelsOnboardingMark>(wire<C.ChannelsOnboardingMark>());

  // Memory (`/projects/:id/memory/*`, files in Drive). The inputs are checked the other way: what the SDK sends parses.
  fits<ProjectMemoryLayer>(wire<C.MemoryLayer>());
  noPhantom<NoPhantom<ProjectMemoryLayer, C.MemoryLayer>>();
  fits<ProjectMemoryPageSummary>(wire<C.MemoryPageSummary>());
  noPhantom<NoPhantom<ProjectMemoryPageSummary, C.MemoryPageSummary>>();
  fits<ProjectMemoryPage>(wire<C.MemoryPage>());
  noPhantom<NoPhantom<ProjectMemoryPage, C.MemoryPage>>();
  fits<ProjectMemoryVersionList>(wire<C.MemoryVersionList>());
  noPhantom<NoPhantom<ProjectMemoryVersionList['versions'][number], C.MemoryVersion>>();
  fits<ProjectMemoryDeleteResult>(wire<C.MemoryDeleteResult>());
  noPhantom<NoPhantom<ProjectMemoryDeleteResult, C.MemoryDeleteResult>>();
  fits<C.MemoryPageCreateInput>(wire<CreateProjectMemoryPageInput>());
  fits<C.MemoryPageUpdateInput>(wire<UpdateProjectMemoryPageInput>());
  fits<C.MemoryNoteInput>(wire<AddProjectMemoryNoteInput>());
  fits<ProjectMemorySearchResult>(wire<C.MemorySearchResult>());
  noPhantom<NoPhantom<ProjectMemorySearchResult['hits'][number], C.MemorySearchHit>>();
  fits<C.MemorySearchHit['type']>(wire<NonNullable<ProjectMemorySearchInput['type']>>());
  fits<SessionMemoryUsage>(wire<C.MemoryUsage>());
  noPhantom<NoPhantom<SessionMemoryUsage, C.MemoryUsage>>();
  noPhantom<NoPhantom<SessionMemoryUsage['layers'][number], C.MemoryUsage['layers'][number]>>();
  noPhantom<NoPhantom<SessionMemoryUsage['layers'][number]['pages'][number], C.MemoryUsage['layers'][number]['pages'][number]>>();

  fits<SessionStartResult>(wire<C.SessionStartResult>());
  noPhantom<NoPhantom<SessionStartResult, C.SessionStartResult>>();

  fits<WarmProjectSessionResult>(wire<C.WarmProjectSessionResult>());
  noPhantom<NoPhantom<WarmProjectSessionResult, C.WarmProjectSessionResult>>();

  fits<ProjectTrigger>(wire<C.Trigger>());
  noPhantom<NoPhantom<ProjectTrigger, C.Trigger>>();
  fits<ProjectTriggerListing>(wire<C.TriggerList>());
  noPhantom<NoPhantom<ProjectTriggerListing, C.TriggerList>>();
  fits<ProjectTriggerRun>(wire<C.TriggerRun>());
  noPhantom<NoPhantom<ProjectTriggerRun, C.TriggerRun>>();
  fits<ProjectTriggerRunList>(wire<C.TriggerRunList>());
  noPhantom<NoPhantom<ProjectTriggerRunList, C.TriggerRunList>>();
  fits<ProjectTriggerDryRunResult>(wire<C.TriggerDryRunResult>());
  noPhantom<NoPhantom<ProjectTriggerDryRunResult, C.TriggerDryRunResult>>();

  fits<SessionTranscript>(wire<C.SessionTranscript>());
  noPhantom<NoPhantom<SessionTranscript, C.SessionTranscript>>();
  noPhantom<NoPhantom<SessionTranscriptMessage, C.SessionTranscriptMessage>>();
  fits<SessionTranscriptSyncEnvelope>(wire<C.SessionTranscriptSyncEnvelope>());
  noPhantom<NoPhantom<SessionTranscriptSyncEnvelope, C.SessionTranscriptSyncEnvelope>>();

  fits<SessionTurnStatus>(wire<C.SessionTurnStatus>());
  noPhantom<NoPhantom<SessionTurnStatus, C.SessionTurnStatus>>();
  noPhantom<NoPhantom<SessionTurn, C.SessionTurn>>();
  noPhantom<NoPhantom<SessionTurnEnded, C.SessionTurnEnded>>();
  noPhantom<NoPhantom<SessionTurnFailure, C.SessionTurnFailure>>();

  fits<SessionPrompt>(wire<C.SessionPrompt>());
  noPhantom<NoPhantom<SessionPrompt, C.SessionPrompt>>();
  fits<CreateSessionPromptResult>(wire<C.CreateSessionPromptResult>());
  noPhantom<NoPhantom<CreateSessionPromptResult, C.CreateSessionPromptResult>>();

  fits<SessionOpenBundle>(wire<C.SessionSnapshot>());
  noPhantom<NoPhantom<SessionOpenBundle, C.SessionSnapshot>>();
  noPhantom<NoPhantom<SessionAuditAction, C.SessionAuditAction>>();

  fits<ChangeRequest>(wire<C.ChangeRequest>());
  noPhantom<NoPhantom<ChangeRequest, C.ChangeRequest>>();

  fits<KortixAccount>(wire<C.AccountSummary>());
  noPhantom<NoPhantom<KortixAccount, C.AccountSummary>>();

  // Kortix Capture data API (`/accounts/:id/capture/*`).
  fits<CaptureWorkspace>(wire<C.CaptureWorkspace>());
  noPhantom<NoPhantom<CaptureWorkspace, C.CaptureWorkspace>>();
  fits<CaptureSearchResult>(wire<C.CaptureSearchResult>());
  noPhantom<NoPhantom<CaptureSearchResult, C.CaptureSearchResult>>();
  noPhantom<NoPhantom<CaptureSearchHit, C.CaptureSearchHit>>();

  // GET .../log (P4.2). `SessionLogPage` is written out in the SDK (no zod). Its envelope is
  // checked both ways here; the records inside (`SessionLogMessage`, the thread and session
  // records) are the vendored `types.ts`, held byte-equal by `core/session-log/types.test.ts`.
  // They are not compared with `z.infer`: the schema infers `payload` optional and widens
  // `ModelRef.api`, a difference between api-contract's own types and schema.
  fits<PageEnvelope<SessionLogPage>>(wire<PageEnvelope<SL.SessionLogPage>>());
  fits<PageEnvelope<SL.SessionLogPage>>(wire<PageEnvelope<SessionLogPage>>());
  noPhantom<NoPhantom<SessionLogPage, SL.SessionLogPage>>();
  noPhantom<NoPhantom<SL.SessionLogPage, SessionLogPage>>();
  noPhantom<NoPhantom<SessionLogPage['session'], SL.SessionLogPage['session']>>();
  noPhantom<NoPhantom<SL.SessionLogPage['session'], SessionLogPage['session']>>();
}

/** A page with its records reduced to their presence: the envelope fields keep their types. */
type PageEnvelope<P> = { [K in keyof P]: K extends 'session' | 'threads' | 'messages' ? unknown : P[K] };

test('the contract drift checks are a typecheck target', () => {
  expect(typeof contractDrift).toBe('function');
});
