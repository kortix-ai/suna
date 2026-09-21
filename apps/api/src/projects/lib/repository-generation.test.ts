import { expect, test } from 'bun:test';
import { sessionUsesCurrentRepository } from './repository-generation';

test('legacy projects accept sessions created before repository generations existed', () => {
  expect(sessionUsesCurrentRepository({}, {})).toBe(true);
});

test('a repository switch blocks old sessions and allows sessions pinned to its generation', () => {
  const project = { repository_generation: 'generation-b' };
  expect(sessionUsesCurrentRepository(project, {})).toBe(false);
  expect(sessionUsesCurrentRepository(project, { repository_generation: 'generation-a' })).toBe(false);
  expect(sessionUsesCurrentRepository(project, { repository_generation: 'generation-b' })).toBe(true);
});
