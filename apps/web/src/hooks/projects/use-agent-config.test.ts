import type { AgentConfigResponse } from '@kortix/sdk';
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, test } from 'bun:test';

import { agentConfigQueryKey, applyAgentConfigSaveResponse } from './use-agent-config';

describe('applyAgentConfigSaveResponse', () => {
  test('replaces a stale all-secrets grant with the explicit saved list', () => {
    const queryClient = new QueryClient();
    const key = agentConfigQueryKey('project-1', 'kortix');
    const stale: AgentConfigResponse = {
      agent: 'kortix',
      schema_version: 2,
      editable: true,
      default_agent: 'kortix',
      block: { secrets: 'all' },
    };
    queryClient.setQueryData(key, stale);

    applyAgentConfigSaveResponse(queryClient, 'project-1', 'kortix', {
      ok: true,
      agent: 'kortix',
      schema_version: 2,
      block: { secrets: ['MAIL_TOKEN'] },
    });

    expect(queryClient.getQueryData<AgentConfigResponse>(key)).toEqual({
      ...stale,
      block: { secrets: ['MAIL_TOKEN'] },
    });
  });
});
