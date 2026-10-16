import { describe, expect, test } from 'bun:test';

import { MIGRATE_TO_V3_PROMPT } from './migration-prompt';
import { buildMigrateToV3Stash } from './use-migrate-to-v3';

describe('buildMigrateToV3Stash', () => {
  test('seeds the session with the migration prompt and no agent/model override', () => {
    expect(buildMigrateToV3Stash()).toEqual({
      prompt: MIGRATE_TO_V3_PROMPT,
      agent: null,
      model: null,
      variant: null,
    });
  });

  test('agent is null so the session boots the project default agent', () => {
    expect(buildMigrateToV3Stash().agent).toBeNull();
  });
});
