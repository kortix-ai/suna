import { expect, test } from 'bun:test';
import {
  sessionRepositoryStartDecision,
  sessionUsesCurrentRepository,
} from './repository-generation';

test('legacy projects accept sessions created before repository generations existed', () => {
  expect(sessionUsesCurrentRepository({}, {})).toBe(true);
});

test('a repository switch blocks old sessions and allows sessions pinned to its generation', () => {
  const project = { repository_generation: 'generation-b' };
  expect(sessionUsesCurrentRepository(project, {})).toBe(false);
  expect(
    sessionUsesCurrentRepository(project, {
      repository_generation: 'generation-a',
    }),
  ).toBe(false);
  expect(
    sessionUsesCurrentRepository(project, {
      repository_generation: 'generation-b',
    }),
  ).toBe(true);
});

test('a previous-repository session requires an explicit mode and a preserved runtime', () => {
  const project = { repository_generation: 'generation-b' };
  const session = { repository_generation: 'generation-a' };

  expect(
    sessionRepositoryStartDecision(project, session, {
      repositoryMode: undefined,
      hasPreservedRuntime: true,
    }),
  ).toEqual({ ok: false, code: 'session_repository_changed' });

  expect(
    sessionRepositoryStartDecision(project, session, {
      repositoryMode: 'previous',
      hasPreservedRuntime: false,
    }),
  ).toEqual({ ok: false, code: 'previous_repository_runtime_unavailable' });

  expect(
    sessionRepositoryStartDecision(project, session, {
      repositoryMode: 'previous',
      hasPreservedRuntime: true,
    }),
  ).toEqual({ ok: true, repository: 'previous' });
});

test('a current-repository session never needs the bypass', () => {
  expect(
    sessionRepositoryStartDecision(
      { repository_generation: 'generation-b' },
      { repository_generation: 'generation-b' },
      { repositoryMode: undefined, hasPreservedRuntime: false },
    ),
  ).toEqual({ ok: true, repository: 'current' });
});
