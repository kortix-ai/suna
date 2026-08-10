import { describe, expect, test } from 'bun:test';

import { createAgentSelectionScope } from './agent-selection-scope';

describe('createAgentSelectionScope', () => {
  test('stays stable while an asynchronous project default hydrates', () => {
    const beforeProjectDefault = createAgentSelectionScope({
      workspaceId: 'project-1',
    });
    const afterProjectDefault = createAgentSelectionScope({
      workspaceId: 'project-1',
    });

    expect(afterProjectDefault).toBe(beforeProjectDefault);
  });

  test('resets an explicit composer selection when the route project changes', () => {
    expect(createAgentSelectionScope({ workspaceId: 'project-1' })).not.toBe(
      createAgentSelectionScope({ workspaceId: 'project-2' }),
    );
  });

  test('keeps session and server-bound agent identity in the scope', () => {
    expect(
      createAgentSelectionScope({
        workspaceId: 'project-1',
        sessionId: 'session-1',
        boundAgentName: 'kortix',
      }),
    ).not.toBe(
      createAgentSelectionScope({
        workspaceId: 'project-1',
        sessionId: 'session-2',
        boundAgentName: 'kortix',
      }),
    );
  });
});
