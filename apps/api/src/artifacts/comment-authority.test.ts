import { beforeEach, expect, mock, test } from 'bun:test';
import { artifactComments, artifactCommentThreads, artifacts, jobQueue, projectSessions } from '@kortix/db';
import { HTTPException } from 'hono/http-exception';
import type { Actor, TokenBinding } from '../iam/actor';
import type { AccountTokenValidationResult } from '../repositories/account-tokens';

const A = '10000000-0000-4000-8000-000000000001';
const U = '10000000-0000-4000-8000-000000000002';
const P = '10000000-0000-4000-8000-000000000003';
const S = '10000000-0000-4000-8000-000000000004';
const T = '10000000-0000-4000-8000-000000000005';
const F = '10000000-0000-4000-8000-000000000006';
const H = '10000000-0000-4000-8000-000000000007';
const C = '10000000-0000-4000-8000-000000000008';
const J = '10000000-0000-4000-8000-000000000009';
const SA = '10000000-0000-4000-8000-000000000010';
const key = `artifact-comments:${H}:${C}`;
let checked: AccountTokenValidationResult;
let original: Actor;
let project: Record<string, unknown>;
let session: Record<string, unknown>;
let artifact: Record<string, unknown>;
let thread: Record<string, unknown>;
let comment: Record<string, unknown>;
let job: Record<string, unknown>;
let visible = true;
let viewable = true;
let humanPrompt = true;
let agentAllowed = true;
let channelOnly = false;
let startAllowed: (actor: Actor) => boolean = () => true;
const bindings: Array<{ sessionId: string | null; known: TokenBinding }> = [];
const visibilityCalls: unknown[][] = [];
const agentCalls: unknown[][] = [];
const invalidated: string[] = [];
let humanChecks = 0;

mock.module('../repositories/account-tokens', () => ({ validateAccountTokenById: async () => checked }));
mock.module('../iam/actor', () => ({
  loadTokenBinding: { invalidate: (id: string) => invalidated.push(id) },
  tokenCredential: async (tokenId: string, _accountId: string, sessionId: string | null, known: TokenBinding) => {
    bindings.push({ sessionId, known });
    return known.serviceAccountId ? { kind: 'agent_session', tokenId, sessionId, projectId: known.projectId,
      serviceAccountId: known.serviceAccountId, agentGrant: known.agentGrant, activated: true, agentPrincipal: true,
      onBehalfOfUserId: known.onBehalfOfUserId } : { kind: 'pat', tokenId, projectId: known.projectId };
  },
  actingPrincipal: (actor: Actor) => ({ type: actor.credential.kind === 'agent_session' || actor.credential.kind === 'service_account' ? 'service_account' : 'user' }),
}));
mock.module('../iam/authorize', () => ({ authorize: async (actor: Actor, action: string) => ({ allowed: action !== 'project.session.start' || startAllowed(actor) }) }));
mock.module('../drives/service', () => ({ privateChannelFoldersFor: async () => ({ visible: new Set(), all: new Set() }) }));
mock.module('../feature-flags/registry', () => ({ resolveFeatureFlag: () => true }));
mock.module('../notifications/access', () => ({ mayPromptSessions: async () => { humanChecks++; return new Set(humanPrompt ? [S] : []); } }));
mock.module('../projects/surface', () => ({
  loadVisibleSession: async (...args: unknown[]) => { visibilityCalls.push(args); return visible ? { row: session } : null; },
  sessionIsTombstoned: (row: { metadata?: { deletedAt?: string } }) => !!row.metadata?.deletedAt,
  resolveAndAuthorizeAgentAs: async (...args: unknown[]) => {
    agentCalls.push(args);
    if (!agentAllowed || (channelOnly && !args[7])) throw new HTTPException(403);
    return { agentName: 'builder' };
  },
}));
mock.module('./service', () => ({ canView: () => viewable }));
const rows = (table: unknown) => table === jobQueue ? [job] : table === artifacts ? [{ artifact, project }]
  : table === artifactCommentThreads ? [thread] : table === artifactComments ? [comment] : table === projectSessions ? [session] : [];
class Query {
  constructor(readonly table: unknown) {}
  where() { return this; }
  innerJoin() { return this; }
  orderBy() { return this; }
  async limit() { return rows(this.table); }
  then(resolve: (value: unknown[]) => void, reject: (error: unknown) => void) { return Promise.resolve(rows(this.table)).then(resolve, reject); }
}
mock.module('../shared/db', () => ({ db: { select: () => ({ from: (table: unknown) => new Query(table) }), selectDistinctOn: () => ({ from: (table: unknown) => new Query(table) }) } }));

const { ArtifactCommentAuthorityError, authorizeArtifactCommentAgent, refreshArtifactCommentActor,
  revalidateArtifactCommentContinue, revalidateArtifactCommentCreate } = await import('./comment-authority');

beforeEach(() => {
  checked = { isValid: true, accountId: A, userId: U, tokenId: T, projectId: P, sessionId: null, serviceAccountId: null, agentGrant: null, onBehalfOfUserId: null };
  original = { accountId: A, userId: U, credential: { kind: 'pat', tokenId: T, projectId: P }, ctx: {} };
  project = { accountId: A, projectId: P, status: 'active', metadata: {} };
  session = { accountId: A, projectId: P, sessionId: S, agentName: 'builder', spaceId: 'channel-one', metadata: {} };
  artifact = { accountId: A, projectId: P, artifactId: F };
  thread = { threadId: H, artifactId: F, projectId: P, agentState: 'pending' };
  comment = { commentId: C, threadId: H, authorUserId: U, authorSessionId: null, deletedAt: null, mentions: [{ kind: 'agent', agent_name: 'builder' }] };
  job = { jobId: J, artifactId: F, status: 'queued', payload: { actor: original, artifactId: F, callerSessionId: null, threadIds: [H], commentId: C,
    targets: [{ recipientKey: 'agent:builder', sessionId: S, agentName: 'builder', created: true, key, implicit: false, status: 'pending' }] } };
  visible = true; viewable = true; humanPrompt = true; agentAllowed = true; channelOnly = false;
  startAllowed = () => true;
  humanChecks = 0; bindings.length = 0; visibilityCalls.length = 0; agentCalls.length = 0; invalidated.length = 0;
});
const create = () => ({ source: 'system:artifact-comment', artifactId: F, project, userId: U, requestingPrincipalType: 'human',
  body: { session_id: S, agent_name: 'builder' }, idempotencyKey: key, metadata: { artifactCommentDelivery: { job_id: J, target_key: key } } }) as never;
const continueRow = () => ({ accountId: A, projectId: P, artifactId: F, sessionId: S, actorUserId: U, idempotencyKey: key });
const target = () => (job.payload as { targets: Array<Record<string, unknown>> }).targets[0]!;

test('revoked credentials never widen to the launching user, while unavailable validation remains retryable', async () => {
  checked = { isValid: false, credentialDead: true };
  await expect(refreshArtifactCommentActor(original)).rejects.toBeInstanceOf(ArtifactCommentAuthorityError);
  expect(bindings).toHaveLength(0);
  checked = { isValid: false, error: 'Validation error' };
  await expect(refreshArtifactCommentActor(original)).rejects.toThrow('validation is unavailable');
});

test('changed token tenant or project scopes are refused', async () => {
  checked.accountId = U;
  await expect(refreshArtifactCommentActor(original)).rejects.toBeInstanceOf(ArtifactCommentAuthorityError);
  checked.accountId = A; checked.projectId = U;
  await expect(refreshArtifactCommentActor(original)).rejects.toBeInstanceOf(ArtifactCommentAuthorityError);
});

test('fresh governed delegation uses current grants and on-behalf-of without the launcher prompt check', async () => {
  original.credential = { kind: 'agent_session', tokenId: T, projectId: P, sessionId: S, serviceAccountId: SA, activated: true, agentPrincipal: true, agentGrant: null, onBehalfOfUserId: U };
  checked = { ...checked, sessionId: S, serviceAccountId: SA, onBehalfOfUserId: null, agentGrant: { agent: 'builder', permissions: [] } as never };
  humanPrompt = false;
  const result = await authorizeArtifactCommentAgent(original, project as never, 'builder', session as never);
  expect(result.canPromptExisting).toBe(true);
  expect(humanChecks).toBe(0);
  expect(bindings[0]!.known.agentGrant).toEqual(checked.agentGrant ?? null);
  expect(agentCalls[0]![1]).toBeNull();
  expect(invalidated).toEqual([T]);
  startAllowed = (actor) => actor.credential.kind !== 'agent_session';
  await expect(authorizeArtifactCommentAgent(original, project as never, 'builder')).rejects.toBeInstanceOf(ArtifactCommentAuthorityError);
});

test('legacy session-bound PATs retain both visibility bindings', async () => {
  checked.sessionId = S;
  const result = await authorizeArtifactCommentAgent(original, project as never, 'builder', session as never);
  expect(result.callerSessionId).toBe(S);
  expect(visibilityCalls[0]!.slice(2)).toEqual([S, S]);
});

test('channel run rights apply to the visible existing session, but cannot authorize a private fallback', async () => {
  channelOnly = true;
  expect((await authorizeArtifactCommentAgent(original, project as never, 'builder', session as never)).canPromptExisting).toBe(true);
  expect(agentCalls[0]![7]).toBe('channel-one');
  humanPrompt = false;
  await expect(authorizeArtifactCommentAgent(original, project as never, 'builder', session as never)).rejects.toBeInstanceOf(ArtifactCommentAuthorityError);
});

test('delayed creates bind the exact reserved target and refuse removed mentions, deleted comments and private access loss', async () => {
  await expect(revalidateArtifactCommentCreate(create())).resolves.toMatchObject({ callerSessionId: null });
  target().sessionId = U;
  await expect(revalidateArtifactCommentCreate(create())).rejects.toBeInstanceOf(ArtifactCommentAuthorityError);
  target().sessionId = S; comment.mentions = [];
  await expect(revalidateArtifactCommentCreate(create())).rejects.toBeInstanceOf(ArtifactCommentAuthorityError);
  comment.mentions = [{ kind: 'agent', agent_name: 'builder' }]; comment.deletedAt = new Date();
  await expect(revalidateArtifactCommentCreate(create())).rejects.toBeInstanceOf(ArtifactCommentAuthorityError);
  comment.deletedAt = null; viewable = false;
  await expect(revalidateArtifactCommentCreate(create())).rejects.toBeInstanceOf(ArtifactCommentAuthorityError);
});

test('delayed continues keep completed delivery context and recheck current session prompt rights', async () => {
  job.status = 'done'; target().created = false; target().status = 'sent';
  await expect(revalidateArtifactCommentContinue(continueRow(), { job_id: J, target_key: key })).resolves.toMatchObject({ callerSessionId: null });
  humanPrompt = false;
  await expect(revalidateArtifactCommentContinue(continueRow(), { job_id: J, target_key: key })).rejects.toBeInstanceOf(ArtifactCommentAuthorityError);
});

test('the reserved pending-first child uses creation authority while its delivery remains pending', async () => {
  visible = false;
  await expect(revalidateArtifactCommentContinue({ ...continueRow(), idempotencyKey: `prompt:${S}:pending-first` }, { job_id: J, target_key: key }))
    .resolves.toMatchObject({ callerSessionId: null });
  await expect(revalidateArtifactCommentContinue(continueRow(), { job_id: J, target_key: key })).rejects.toBeInstanceOf(ArtifactCommentAuthorityError);
});

test('a sent fanout target survives another target failure but dead pending targets and loop pauses remain blocked', async () => {
  job.status = 'dead'; target().created = false; target().status = 'sent';
  thread.agentState = 'paused'; thread.agentError = 'Another recipient failed';
  await expect(revalidateArtifactCommentContinue(continueRow(), { job_id: J, target_key: key })).resolves.toMatchObject({ callerSessionId: null });
  target().created = true; target().status = 'pending';
  await expect(revalidateArtifactCommentContinue({ ...continueRow(), idempotencyKey: `prompt:${S}:pending-first` }, { job_id: J, target_key: key }))
    .rejects.toBeInstanceOf(ArtifactCommentAuthorityError);
  target().created = false; target().status = 'sent'; thread.agentError = null;
  await expect(revalidateArtifactCommentContinue(continueRow(), { job_id: J, target_key: key })).rejects.toBeInstanceOf(ArtifactCommentAuthorityError);
});

test('manual Send rejects legacy PAT session binding changes before delayed creation or continuation', async () => {
  const payload = job.payload as Record<string, unknown>;
  delete payload.commentId;
  payload.manual = true;
  target().implicit = true;
  for (const [saved, current] of [[null, S], [S, null], [S, SA]] as const) {
    payload.callerSessionId = saved;
    checked.sessionId = current;
    target().created = true; target().status = 'pending';
    await expect(revalidateArtifactCommentCreate(create())).rejects.toBeInstanceOf(ArtifactCommentAuthorityError);
    target().created = false; target().status = 'sent';
    await expect(revalidateArtifactCommentContinue(continueRow(), { job_id: J, target_key: key })).rejects.toBeInstanceOf(ArtifactCommentAuthorityError);
  }
  payload.callerSessionId = S; checked.sessionId = S;
  target().created = true; target().status = 'pending';
  await expect(revalidateArtifactCommentCreate(create())).resolves.toMatchObject({ callerSessionId: S });
  target().created = false; target().status = 'sent';
  await expect(revalidateArtifactCommentContinue(continueRow(), { job_id: J, target_key: key })).resolves.toMatchObject({ callerSessionId: S });
});
