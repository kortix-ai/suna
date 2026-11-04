import { expect, test } from 'bun:test';
import { artifactAgentMentionToken, artifactPersonMentionToken, hydrateArtifactCommentMentions } from './comment-tokens';
import { mentionTokens } from '../projects/rooms/envelope';

test('agent insertion tokens use a reserved namespace and survive the shared parser', () => {
  for (const name of ['writer', 'a', 'a'.repeat(128), 'Zoë writer', 'agent.writer', 'writer.', 'Writer', 'hash.' + 'a'.repeat(40)]) {
    const token = artifactAgentMentionToken(name);
    expect(token.startsWith('@agent.')).toBe(true);
    expect([...mentionTokens(token)]).toEqual([token.slice(1)]);
  }
  expect(artifactAgentMentionToken('writer')).toBe('@agent.writer');
  expect(artifactAgentMentionToken('Zoë writer')).toBe(artifactAgentMentionToken('Zoë writer'));
});

test('people use a unique accepted email or their complete user id', () => {
  const id = '0e378181-1069-4cf9-b43b-c46af932a28e';
  expect(artifactPersonMentionToken(id, 'alice@example.test', new Set())).toBe('@alice@example.test');
  expect(artifactPersonMentionToken(id, 'alice@example.test', new Set(['alice@example.test']))).toBe(`@${id}`);
  expect(artifactPersonMentionToken(id, 'not an email', new Set())).toBe(`@${id}`);
});

test('stored agent and session mentions expose canonical server tokens without changing persisted identities', () => {
  const person = { kind: 'user' as const, user_id: 'person' };
  const session = Object.freeze({ kind: 'session' as const, session_id: 'session', agent_name: 'kortix' });
  const agent = Object.freeze({ kind: 'agent' as const, agent_name: 'Zoë writer' });
  expect(hydrateArtifactCommentMentions([person, session, agent])).toEqual([
    person, { ...session, token: '@agent.kortix' }, { ...agent, token: artifactAgentMentionToken(agent.agent_name) },
  ]);
  expect(hydrateArtifactCommentMentions([])).toEqual([]);
  expect(session).not.toHaveProperty('token');
  expect(agent).not.toHaveProperty('token');
});
