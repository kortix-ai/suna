import { describe, expect, test } from 'bun:test';

import { createAgentSelectionScope } from './agent-selection-scope';

describe('createAgentSelectionScope', () => {
  test('stays stable while an asynchronous project default hydrates', () => {
    const beforeProjectDefault = createAgentSelectionScope({
      projectId: 'project-1',
    });
    const afterProjectDefault = createAgentSelectionScope({
      projectId: 'project-1',
    });

    expect(afterProjectDefault).toBe(beforeProjectDefault);
  });

  test('resets an explicit composer selection when the route project changes', () => {
    expect(createAgentSelectionScope({ projectId: 'project-1' })).not.toBe(
      createAgentSelectionScope({ projectId: 'project-2' }),
    );
  });

  test('keeps session and server-bound agent identity in the scope', () => {
    expect(
      createAgentSelectionScope({
        projectId: 'project-1',
        sessionId: 'session-1',
        boundAgentName: 'kortix',
      }),
    ).not.toBe(
      createAgentSelectionScope({
        projectId: 'project-1',
        sessionId: 'session-2',
        boundAgentName: 'kortix',
      }),
    );
  });
});
