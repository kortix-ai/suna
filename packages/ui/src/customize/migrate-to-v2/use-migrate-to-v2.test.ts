import { describe, expect, test } from 'bun:test';

import { MIGRATE_TO_V2_PROMPT } from './migration-prompt';
import { pendingUpgradePrompt } from './use-run-upgrade';

describe('pendingUpgradePrompt', () => {
  test('seeds the session with the migration prompt and no agent/model override', () => {
    expect(pendingUpgradePrompt(MIGRATE_TO_V2_PROMPT)).toEqual({
      text: MIGRATE_TO_V2_PROMPT,
      agent: null,
      model: null,
      variant: null,
    });
  });

  test('agent is null so the session boots the project default agent', () => {
    expect(pendingUpgradePrompt(MIGRATE_TO_V2_PROMPT).agent).toBeNull();
  });
});
