import { expect, test } from 'bun:test';
import type {
  AuditEvent,
  ChannelBinding,
  CreateProjectSessionInput,
  ProjectSession,
  PublicSessionTranscript,
  SessionModelChangeResult,
  SessionOpenBundleRuntime,
  SessionReloadResult,
  SessionStartResult,
  SessionTranscript,
  SessionTranscriptSyncEnvelope,
  SessionTurn,
  UpdateChannelBindingInput,
} from './index';

/**
 * Every session runs pi. The API answered each runtime field under two names
 * until 0.15.0: the neutral one and its OpenCode-era alias (`opencode_session_id`,
 * `opencode_sessions`, `opencode_version`, `opencode_model`, `opencode_reload`,
 * `opencodeModel`). Only the neutral names remain. `public-type-surface.test.ts`
 * holds the exported type NAMES; this file holds their fields, at compile time:
 * `pnpm --filter @kortix/sdk typecheck` fails while a type below has such a key.
 */
type OpenCodeKey<T> = T extends unknown ? Extract<keyof T, `opencode${string}` | `Opencode${string}`> : never;
type NoKey<K extends never> = K;
type RuntimeIdentity = Extract<SessionOpenBundleRuntime, { identity: unknown }>['identity'];

export type OpenCodeFieldChecks = [
  NoKey<OpenCodeKey<AuditEvent>>,
  NoKey<OpenCodeKey<ChannelBinding>>,
  NoKey<OpenCodeKey<UpdateChannelBindingInput>>,
  NoKey<OpenCodeKey<CreateProjectSessionInput>>,
  NoKey<OpenCodeKey<ProjectSession>>,
  NoKey<OpenCodeKey<PublicSessionTranscript>>,
  NoKey<OpenCodeKey<SessionModelChangeResult>>,
  NoKey<OpenCodeKey<RuntimeIdentity>>,
  NoKey<OpenCodeKey<SessionReloadResult>>,
  NoKey<OpenCodeKey<SessionStartResult>>,
  NoKey<OpenCodeKey<SessionTranscript>>,
  NoKey<OpenCodeKey<SessionTranscriptSyncEnvelope>>,
  NoKey<OpenCodeKey<SessionTurn>>,
];

test('the runtime fields of sessions, turns, transcripts, audit and channel bindings have only neutral names', () => {
  const sample: Pick<ProjectSession, 'runtime_session_id' | 'runtime_sessions'> & Pick<ChannelBinding, 'model'> = {
    runtime_session_id: 'ses_pi_example',
    runtime_sessions: [],
    model: null,
  };
  expect(Object.keys(sample).filter((key) => /^opencode/i.test(key))).toEqual([]);
});
