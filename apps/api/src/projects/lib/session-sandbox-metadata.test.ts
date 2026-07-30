import { describe, expect, test } from 'bun:test';

import {
  resolveSessionSandboxSlug,
  sandboxSlugFromSessionMetadata,
} from './session-sandbox-metadata';

describe('sandboxSlugFromSessionMetadata', () => {
  test('returns a persisted template slug', () => {
    expect(sandboxSlugFromSessionMetadata({ sandbox_slug: 'ml' })).toBe('ml');
    expect(sandboxSlugFromSessionMetadata({ sandbox_slug: 'default' })).toBe('default');
  });

  test('rejects missing and invalid metadata values', () => {
    expect(sandboxSlugFromSessionMetadata(null)).toBeUndefined();
    expect(sandboxSlugFromSessionMetadata({})).toBeUndefined();
    expect(sandboxSlugFromSessionMetadata({ sandbox_slug: '../escape' })).toBeUndefined();
  });
});

describe('resolveSessionSandboxSlug', () => {
  test('uses explicit, agent, project, then platform precedence', () => {
    expect(
      resolveSessionSandboxSlug({
        explicit: 'override',
        agent: 'ml',
        project: 'node',
      }),
    ).toBe('override');
    expect(resolveSessionSandboxSlug({ agent: 'ml', project: 'node' })).toBe('ml');
    expect(resolveSessionSandboxSlug({ project: 'node' })).toBe('node');
    expect(resolveSessionSandboxSlug({})).toBe('default');
  });
});
