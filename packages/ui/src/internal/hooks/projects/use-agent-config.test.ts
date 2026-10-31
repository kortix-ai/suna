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
      schema_version: 3,
      editable: true,
      default_agent: 'kortix',
      block: { secrets: 'all' },
    };
    queryClient.setQueryData(key, stale);

    applyAgentConfigSaveResponse(queryClient, 'project-1', 'kortix', {
      ok: true,
      agent: 'kortix',
      schema_version: 3,
      block: { secrets: ['MAIL_TOKEN'] },
    });

    expect(queryClient.getQueryData<AgentConfigResponse>(key)).toEqual({
      ...stale,
      block: { secrets: ['MAIL_TOKEN'] },
    });
  });
});

describe('applyAgentConfigSaveResponse on an empty cache', () => {
  test('a saved block is editable: the save itself proves the server accepted the edit', () => {
    const queryClient = new QueryClient();
    applyAgentConfigSaveResponse(queryClient, 'project-1', 'kortix', {
      ok: true,
      agent: 'kortix',
      schema_version: 3,
      block: { skills: 'all', commands: ['weekly-report'] },
    });
    expect(
      queryClient.getQueryData<AgentConfigResponse>(agentConfigQueryKey('project-1', 'kortix'))?.editable,
    ).toBe(true);
  });
});

const hookSource = readFileSync(join(import.meta.dir, 'use-agent-config.ts'), 'utf8');

describe('agent-config save', () => {
  test('a save writes the cache and never refetches the agent-config read', () => {
    const onSuccess = hookSource.slice(hookSource.indexOf('onSuccess:'));
    expect(onSuccess).toContain('applyAgentConfigSaveResponse(');
    expect(onSuccess).not.toContain('agentConfigQueryKey(');
  });
});
