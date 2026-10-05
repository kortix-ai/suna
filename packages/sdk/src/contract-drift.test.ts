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
import type { KortixAccount } from './core/rest/projects-client/accounts';
import type { ChangeRequest } from './core/rest/projects-client/change-requests';
import type { KortixProject } from './core/rest/projects-client/projects';
import type { SessionStartResult } from './core/rest/projects-client/session-sandbox';
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
import type { ProjectTrigger, ProjectTriggerListing } from './core/rest/projects-client/triggers';

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

  fits<SessionStartResult>(wire<C.SessionStartResult>());
  noPhantom<NoPhantom<SessionStartResult, C.SessionStartResult>>();

  fits<WarmProjectSessionResult>(wire<C.WarmProjectSessionResult>());
  noPhantom<NoPhantom<WarmProjectSessionResult, C.WarmProjectSessionResult>>();

  fits<ProjectTrigger>(wire<C.Trigger>());
  noPhantom<NoPhantom<ProjectTrigger, C.Trigger>>();
  fits<ProjectTriggerListing>(wire<C.TriggerList>());
  noPhantom<NoPhantom<ProjectTriggerListing, C.TriggerList>>();

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
}

test('the contract drift checks are a typecheck target', () => {
  expect(typeof contractDrift).toBe('function');
});
