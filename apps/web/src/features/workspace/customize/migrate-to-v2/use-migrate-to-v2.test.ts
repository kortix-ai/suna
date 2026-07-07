import { describe, expect, test } from 'bun:test';

import { MIGRATE_TO_V2_PROMPT } from './migration-prompt';
import { buildMigrateToV2Stash } from './use-migrate-to-v2';

describe('buildMigrateToV2Stash', () => {
  test('seeds the session with the migration prompt and no agent/model override', () => {
    expect(buildMigrateToV2Stash()).toEqual({
      prompt: MIGRATE_TO_V2_PROMPT,
      agent: null,
      model: null,
      variant: null,
    });
  });

  test('agent is null so the session boots the project default agent', () => {
    expect(buildMigrateToV2Stash().agent).toBeNull();
  });
});
