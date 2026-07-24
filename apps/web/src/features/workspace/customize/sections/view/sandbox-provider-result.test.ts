import { describe, expect, test } from 'bun:test';
import type { QueryClient } from '@tanstack/react-query';
import type {
  KortixProject,
  SandboxProviderTransitionState,
  UpdateProjectSandboxProviderResult,
} from '@kortix/sdk';
import {
  applySandboxProviderResult,
  isSandboxProviderTransitionTerminal,
  pollSandboxProviderTransition,
} from './sandbox-provider-result';

function fakeQueryClient() {
  const setCalls: Array<{ key: unknown; value: unknown }> = [];
  const invalidateCalls: Array<unknown> = [];
  const client = {
    setQueryData: (key: unknown, value: unknown) => {
      // Mirror react-query's updater support so functional updates don't throw.
      const resolved = typeof value === 'function' ? (value as (c: unknown) => unknown)(undefined) : value;
      setCalls.push({ key, value: resolved });
      return resolved;
    },
    invalidateQueries: (filters: unknown) => {
      invalidateCalls.push(filters);
      return Promise.resolve();
    },
  } as unknown as QueryClient;
  return { client, setCalls, invalidateCalls };
}

const projectResult = (): UpdateProjectSandboxProviderResult =>
  ({
    kind: 'project',
    project_id: 'p1',
    account_id: 'a1',
    name: 'Proj',
    repo_url: 'https://example.test/r.git',
    default_branch: 'main',
    manifest_path: 'kortix.toml',
    status: 'active',
    metadata: {},
    last_opened_at: null,
    created_at: 'now',
    updated_at: 'now',
    default_sandbox_provider: 'daytona',
  } as unknown as UpdateProjectSandboxProviderResult);

const preparationResult = (): UpdateProjectSandboxProviderResult => ({
  kind: 'preparation',
  transition_id: 't1',
  project_id: 'p1',
  status: 'building',
  source_provider: 'daytona',
  target_provider: 'platinum',
  active_provider: 'daytona',
  label: 'Preparing Platinum',
  generation: 1,
  snapshot_name: 'kortix-ppwarm-secret',
  external_template_id: 'tpl_secret',
  commit_sha: 'abc',
  attempts: 0,
  last_error: null,
  error_class: null,
  requested_at: null,
  ready_at: null,
  activated_at: null,
  immediate: false,
});

describe('applySandboxProviderResult (FIX-L)', () => {
  test('immediate kind:project → writes the project cache (with the discriminant stripped)', () => {
    const { client, setCalls, invalidateCalls } = fakeQueryClient();
    const kind = applySandboxProviderResult(client, 'p1', projectResult());
    expect(kind).toBe('project');
    const projectWrite = setCalls.find(
      (c) => Array.isArray(c.key) && c.key[0] === 'project' && c.key[1] === 'p1',
    );
    expect(projectWrite).toBeDefined();
    const cached = projectWrite!.value as KortixProject & { kind?: string };
    expect(cached.project_id).toBe('p1');
    expect(cached.default_sandbox_provider).toBe('daytona');
    expect('kind' in cached).toBe(false); // discriminant stripped from the cached project
    expect(invalidateCalls.length).toBeGreaterThan(0);
  });

  test('kind:preparation → NEVER writes the project cache (no PreparationView clobber)', () => {
    const { client, setCalls } = fakeQueryClient();
    const kind = applySandboxProviderResult(client, 'p1', preparationResult());
    expect(kind).toBe('preparation');
    // The core guarantee: a preparation result touches NO cache — it is not a project.
    expect(setCalls).toHaveLength(0);
    expect(
      setCalls.some((c) => Array.isArray(c.key) && c.key[0] === 'project'),
    ).toBe(false);
  });
});

describe('isSandboxProviderTransitionTerminal', () => {
  test('terminal statuses + null are terminal; live statuses are not', () => {
    for (const s of ['activated', 'failed', 'superseded', 'cancelled', 'noop', 'cleared', null, undefined]) {
      expect(isSandboxProviderTransitionTerminal(s)).toBe(true);
    }
    for (const s of ['pending', 'building', 'ready', 'activating']) {
      expect(isSandboxProviderTransitionTerminal(s)).toBe(false);
    }
  });
});

function stateWith(status: string): SandboxProviderTransitionState {
  return {
    active_provider: 'daytona',
    latest: {
      transition_id: 't1',
      project_id: 'p1',
      status,
      source_provider: 'daytona',
      target_provider: 'platinum',
      generation: 1,
      label: `state ${status}`,
      error_class: null,
      requested_at: null,
      ready_at: null,
      activated_at: null,
      immediate: false,
    },
    history: [],
  };
}

describe('pollSandboxProviderTransition (FIX-L)', () => {
  test('polls until a terminal status, then settles with the terminal state', async () => {
    const seq = [stateWith('building'), stateWith('building'), stateWith('activated')];
    let i = 0;
    let settled: SandboxProviderTransitionState | null | undefined;
    const result = await pollSandboxProviderTransition('p1', {
      fetchState: async () => seq[Math.min(i++, seq.length - 1)],
      baseDelayMs: 0,
      maxDelayMs: 0,
      sleep: async () => {},
      onSettled: (s) => {
        settled = s;
      },
    });
    expect(result?.latest?.status).toBe('activated');
    expect(settled?.latest?.status).toBe('activated');
    expect(i).toBe(3); // building, building, activated
  });

  test('a 404 / read error is terminal (nothing to poll) → settles with null', async () => {
    let settledCalledWith: SandboxProviderTransitionState | null | undefined = undefined;
    const result = await pollSandboxProviderTransition('p1', {
      fetchState: async () => {
        throw new Error('404 Not Found');
      },
      sleep: async () => {},
      onSettled: (s) => {
        settledCalledWith = s;
      },
    });
    expect(result).toBeNull();
    expect(settledCalledWith).toBeNull();
  });

  test('no live transition (latest=null) is terminal immediately', async () => {
    let calls = 0;
    const result = await pollSandboxProviderTransition('p1', {
      fetchState: async () => {
        calls++;
        return { active_provider: 'platinum', latest: null, history: [] };
      },
      sleep: async () => {},
    });
    expect(result?.latest).toBeNull();
    expect(calls).toBe(1); // stopped after the first read
  });
});
