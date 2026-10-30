import { beforeEach, expect, mock, test } from 'bun:test';
import { accountMembers, projects, projectSessions } from '@kortix/db';
import { mentionTokens, mentionsMember } from '../projects/rooms/envelope';

let reads = 0;
let manifests = 0;
let aliceName = 'Alice';
const people = [{ userId: 'alice-identifier' }, { userId: 'hidden-identifier' }];
mock.module('../shared/db', () => ({ db: { select: () => ({ from: (table: unknown) => ({ where: async () => {
  reads++;
  if (table === accountMembers) return people;
  if (table === projectSessions) return [{ id: 'source-session', agent: 'writer' }];
  if (table === projects) return [{ projectId: 'project-one' }];
  throw new Error('Unexpected mention lookup');
} }) }) } }));
mock.module('../projects/surface', () => ({ mentionTokens, mentionsMember,
  resolveUserIdentities: async () => new Map([
    ['alice-identifier', { displayName: aliceName, email: 'alice@example.test' }],
    ['hidden-identifier', { displayName: 'Hidden', email: 'hidden@example.test' }],
  ]),
  loadProjectAgents: async () => { manifests++; return { specs: [{ name: 'writer', enabled: true }, { name: 'researcher', enabled: true }, { name: 'disabled', enabled: false }] }; },
}));
mock.module('../notifications/access', () => ({ filterArtifactRecipients: async (_artifact: unknown, ids: string[]) => ids.filter((id) => id === 'alice-identifier') }));
const { resolveArtifactCommentMentions } = await import('./comment-mentions');
const artifact = { accountId: 'account-one', projectId: 'project-one', createdBySessionId: 'source-session' } as Parameters<typeof resolveArtifactCommentMentions>[0];
beforeEach(() => { reads = 0; manifests = 0; aliceName = 'Alice'; });

test('feedback without mention tokens reads no members, sessions, or manifest', async () => {
  expect(await resolveArtifactCommentMentions(artifact, 'Check the heading.')).toEqual([]);
  expect(reads).toBe(0);
  expect(manifests).toBe(0);
});

test('people mentions store only current viewers and @all/@here never select agents', async () => {
  expect(await resolveArtifactCommentMentions(artifact, '@Alice @Hidden')).toEqual([{ kind: 'user', user_id: 'alice-identifier' }]);
  expect(await resolveArtifactCommentMentions(artifact, '@all @here')).toEqual([{ kind: 'user', user_id: 'alice-identifier' }]);
  expect(manifests).toBe(0);
});

test('all explicit agent targets survive resolution and the Artifact source session wins its agent name', async () => {
  expect(await resolveArtifactCommentMentions(artifact, '@writer @researcher @disabled @writer')).toEqual([
    { kind: 'session', session_id: 'source-session', agent_name: 'writer' },
    { kind: 'agent', agent_name: 'researcher' },
  ]);
  expect(manifests).toBe(1);
});

test('reserved agent aliases resolve before people and preserve every enabled manifest target', async () => {
  expect(await resolveArtifactCommentMentions(artifact, '@agent.writer @agent.researcher @agent.disabled')).toEqual([
    { kind: 'session', session_id: 'source-session', agent_name: 'writer' },
    { kind: 'agent', agent_name: 'researcher' },
  ]);
});

test('an agent alias does not notify a person with the same display name', async () => {
  aliceName = 'agent.writer';
  expect(await resolveArtifactCommentMentions(artifact, '@agent.writer')).toEqual([{ kind: 'session', session_id: 'source-session', agent_name: 'writer' }]);
});
