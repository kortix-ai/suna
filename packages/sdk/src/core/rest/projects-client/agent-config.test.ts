import { describe, expect, test } from 'bun:test';

import type { AgentConfigBlock } from './agent-config';

describe('AgentConfigBlock', () => {
  test('accepts an agent sandbox template slug', () => {
    const block: AgentConfigBlock = { sandbox: 'ml' };
    expect(block.sandbox).toBe('ml');
  });
});
