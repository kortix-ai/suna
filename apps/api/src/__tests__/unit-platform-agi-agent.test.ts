import { describe, expect, test } from 'bun:test';

import { PROJECT_ACTIONS } from '../iam/actions';
import { resolveManifestVerdict } from '../projects/lib/manifest-verdict';
import {
  addPlatformAgiAgent,
  buildPlatformAgiOpenCodeConfig,
  platformAgiAgentGrant,
  platformAgiAgentEnabledForSession,
  projectAgiEnabled,
  resolvePlatformAgiSandbox,
} from '../projects/lib/platform-agi-agent';

describe('platform AGI agent', () => {
  test('adds one reserved AGI agent and replaces a project collision', () => {
    const config = addPlatformAgiAgent({
      agents: [
        {
          name: 'agi',
          path: '/project/AGENTS.md',
          source: 'opencode',
          description: 'project override',
          mode: 'primary',
        },
      ],
      commands: [],
      skills: [],
      is_kortix_repo: true,
      signals: {},
      manifest_raw: null,
      manifest: {},
      manifest_version: resolveManifestVerdict({
        raw: null,
        format: 'yaml',
        path: null,
      }),
      env: { required: [], optional: [] },
      open_code_raw: null,
      open_code_default_agent: null,
      agent_discovery: 'opencode',
    });

    expect(config.agents.filter((agent) => agent.name === 'agi')).toHaveLength(1);
    expect(config.agents[0]).toMatchObject({
      name: 'agi',
      path: '/workspace/AGENTS.md',
      scope: {
        env: [],
        connectors: [],
        kortix_cli: expect.any(Array),
      },
    });
    expect(config.open_code_default_agent).toBe('agi');
  });

  test('defines an OpenCode agent that follows the platform guide', () => {
    expect(JSON.parse(buildPlatformAgiOpenCodeConfig())).toEqual({
      agent: {
        agi: {
          description: 'Starts specialized Kortix sessions and coordinates their work.',
          mode: 'primary',
          prompt:
            'Follow /workspace/AGENTS.md. Coordinate through the Kortix CLI. You are the only coordinator. Claim each task, spawn one specialized worker, then register its immutable bounds and initial prompt with `kortix tasks worker` before waiting. A `queued` worker state or empty new session means prompt delivery is pending, not no-progress. For each settled turn, submit exactly one outcome with its stable settlement id: evidence through `kortix tasks progress --settlement-id`, or no evidence through `kortix tasks no-progress --settlement-id`. Reuse an id only to retry the same outcome; the server permits one continuation, then blocks and escalates. Never ask a worker to spawn another session.',
        },
      },
    });
  });

  test('forces the AGI sandbox and rejects an explicit alternate sandbox', () => {
    expect(resolvePlatformAgiSandbox(undefined)).toBe('agi');
    expect(resolvePlatformAgiSandbox('agi')).toBe('agi');
    expect(() => resolvePlatformAgiSandbox('node22')).toThrow('AGI_SANDBOX_LOCKED');
  });

  test('denies merge authority by construction while retaining other project actions', () => {
    const expectedActions = [
      PROJECT_ACTIONS.PROJECT_READ,
      PROJECT_ACTIONS.PROJECT_GOAL_READ,
      PROJECT_ACTIONS.PROJECT_GOAL_WRITE,
      PROJECT_ACTIONS.PROJECT_TASK_READ,
      PROJECT_ACTIONS.PROJECT_TASK_WRITE,
      PROJECT_ACTIONS.PROJECT_CR_OPEN,
      PROJECT_ACTIONS.PROJECT_SESSION_READ,
      PROJECT_ACTIONS.PROJECT_SESSION_START,
      PROJECT_ACTIONS.PROJECT_FILE_READ,
      PROJECT_ACTIONS.PROJECT_GITOPS_READ,
    ];

    expect(platformAgiAgentGrant()).toEqual({
      agent: 'agi',
      kortixCli: expectedActions,
      connectors: [],
      env: [],
    });
    expect(platformAgiAgentGrant().kortixCli).not.toBe('all');
    expect(platformAgiAgentGrant().kortixCli).not.toContain(PROJECT_ACTIONS.PROJECT_WRITE);
    expect(platformAgiAgentGrant().kortixCli).not.toContain(PROJECT_ACTIONS.PROJECT_SESSION_STOP);
    expect(
      addPlatformAgiAgent({
        agents: [],
        commands: [],
        skills: [],
        is_kortix_repo: true,
        signals: {},
        manifest_raw: null,
        manifest: {},
        manifest_version: resolveManifestVerdict({ raw: null, format: 'yaml', path: null }),
        env: { required: [], optional: [] },
        open_code_raw: null,
        open_code_default_agent: null,
        agent_discovery: 'opencode',
      }).agents[0]?.scope?.kortix_cli,
    ).toEqual(expectedActions);
  });

  test('is gated on the agi feature flag, default off', () => {
    expect(projectAgiEnabled(null)).toBe(false);
    expect(projectAgiEnabled({})).toBe(false);
    expect(projectAgiEnabled({ experimental: {} })).toBe(false);
    expect(projectAgiEnabled({ experimental: { agi: false } })).toBe(false);
    expect(projectAgiEnabled({ experimental: { agi: true } })).toBe(true);
  });

  test('enables AGI only for a trusted generated goal push when the project flag is off', () => {
    expect(platformAgiAgentEnabledForSession(null, 'agi', true)).toBe(true);
    expect(
      platformAgiAgentEnabledForSession({ experimental: { agi: false } }, 'agi', true),
    ).toBe(true);
  });

  test('keeps arbitrary and forged AGI requests gated off by default', () => {
    expect(platformAgiAgentEnabledForSession(null, 'agi', false)).toBe(false);
    expect(platformAgiAgentEnabledForSession(null, 'worker', true)).toBe(false);
    expect(
      platformAgiAgentEnabledForSession({ experimental: { agi: true } }, 'agi', false),
    ).toBe(true);
  });
});
