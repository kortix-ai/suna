import type { AgentConfigResponse } from '@kortix/sdk';
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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

const hookSource = readFileSync(join(import.meta.dir, 'use-agent-config.ts'), 'utf8');
const pageSource = readFileSync(
  join(import.meta.dir, '../../features/workspace/capabilities/agents/agent-page.tsx'),
  'utf8',
);

describe('agent page reads', () => {
  test('the agent-config read starts from the route name, not after project-detail', () => {
    expect(pageSource).toContain('useAgentConfig(projectId, agentName)');
    expect(pageSource).not.toContain('useAgentConfig(projectId, agent ? agentName : undefined)');
  });

  test('the editor option reads start with the page, on the editor keys', () => {
    expect(pageSource).toContain('agentEditorOptionQueries(projectId)');
  });

  test('a save writes the cache and never refetches the agent-config read', () => {
    const onSuccess = hookSource.slice(hookSource.indexOf('onSuccess:'));
    expect(onSuccess).toContain('applyAgentConfigSaveResponse(');
    expect(onSuccess).not.toContain('agentConfigQueryKey(');
  });
});
