import { beforeEach, describe, expect, mock, test } from 'bun:test';

import type { ComposerCapabilities, KortixProject } from '@kortix/sdk/projects-client';

/** One shape for both the default mock and every per-test override, so the
 *  mock's inferred return type can't narrow to whichever literal came first. */
function caps(over: Partial<ComposerCapabilities> = {}): ComposerCapabilities {
  return {
    agent: {
      name: 'kortix',
      runtime: 'opencode',
      harness: 'opencode',
      native_agent: null,
      enabled: true,
    },
    auth: { compatible: [], active: 'managed_gateway', ready: true, reason: null },
    model: {
      policy: 'gateway-catalog',
      default_allowed: true,
      custom_allowed: true,
      live_change: true,
      presets: [{ id: 'glm-5.2', name: 'GLM 5.2', source: 'kortix-gateway' }],
    },
    can_start: true,
    blocking_reason: null,
    ...over,
  };
}

/** The "nothing connected yet" capabilities every skip-path test asserts on. */
const NOT_READY = (reason: string | null): ComposerCapabilities =>
  caps({
    auth: { compatible: [], active: null, ready: false, reason },
    model: {
      policy: 'gateway-catalog',
      default_allowed: false,
      custom_allowed: true,
      live_change: true,
      presets: [],
    },
    can_start: false,
    blocking_reason: reason,
  });

/**
 * The auto-started onboarding / template-setup sessions used to send no model
 * at all, which the platform rejects for any agent whose harness doesn't own
 * its default model (409 MODEL_SELECTION_REQUIRED, "Select a model before
 * starting this agent") — i.e. on every project built from the default
 * starter, every time. The user saw "Project created, but the onboarding
 * session could not be started".
 *
 * These cover the three outcomes the fix distinguishes: started with a model,
 * deliberately not started (no model configured yet — no toast, the composer's
 * own gate is the next step), and genuinely failed (toast, carrying the
 * server's real message rather than a generic wrapper).
 */

const createProjectSession = mock(async (_projectId: string, _input: unknown) => ({
  session_id: 'session-1',
}));
const getProjectDetail = mock(async () => ({
  config: { runtime_default_agent: 'kortix', agents: [{ name: 'kortix', enabled: true }] },
}));
const getComposerCapabilities = mock(async (): Promise<ComposerCapabilities> => caps());
const getModelDefaults = mock(async () => ({
  platformDefault: 'glm-5.2',
  accountDefault: null,
  agentDefaults: {},
  projectDefault: null,
  resolvedForCaller: null,
  freeTier: false,
}));

mock.module('@kortix/sdk/projects-client', () => ({
  createProjectSession,
  getProjectDetail,
  getComposerCapabilities,
  getModelDefaults,
}));

const errorToast = mock((_message: string) => {});
mock.module('@/components/ui/toast', () => ({ errorToast, successToast: mock(() => {}) }));

const { startProjectOnboardingSession, startTemplateSetupSession } = await import(
  './template-setup-session'
);

const PROJECT = { project_id: 'p1', name: 'My project' } as unknown as KortixProject;

beforeEach(() => {
  createProjectSession.mockClear();
  getComposerCapabilities.mockClear();
  errorToast.mockClear();
  getComposerCapabilities.mockImplementation(async () => caps());
  createProjectSession.mockImplementation(async () => ({ session_id: 'session-1' }));
});

describe('startProjectOnboardingSession', () => {
  test('names a concrete model at birth, so the platform gate cannot reject it', async () => {
    const sessionId = await startProjectOnboardingSession(PROJECT);

    expect(sessionId).toBe('session-1');
    const [, input] = createProjectSession.mock.calls[0] as [string, Record<string, unknown>];
    expect(input.model_selection).toEqual({
      kind: 'preset',
      model_id: 'glm-5.2',
      connection_id: 'managed_gateway',
    });
    // The session's boot agent is immutable and must match the agent whose
    // capabilities were just checked.
    expect(input.agent_name).toBe('kortix');
    expect(errorToast).not.toHaveBeenCalled();
  });

  test('no model configured yet → no session, and NO error toast', async () => {
    getComposerCapabilities.mockImplementation(async () => NOT_READY('No model connected'));

    expect(await startProjectOnboardingSession(PROJECT)).toBeNull();
    expect(createProjectSession).not.toHaveBeenCalled();
    // This is an ordinary first-run state, not a failure. The user lands on
    // project home where the composer's connect-a-model gate is the real
    // next step — a red toast here is the bug being fixed.
    expect(errorToast).not.toHaveBeenCalled();
  });

  test('a genuine failure still toasts — and says what the server actually said', async () => {
    createProjectSession.mockImplementation(async () => {
      throw new Error('Session limit reached for this account');
    });

    expect(await startProjectOnboardingSession(PROJECT)).toBeNull();
    expect(errorToast).toHaveBeenCalledTimes(1);
    expect(errorToast.mock.calls[0][0]).toContain('Session limit reached for this account');
  });
});

describe('startTemplateSetupSession — the same defect, the same fix', () => {
  test('names a concrete model at birth', async () => {
    const sessionId = await startTemplateSetupSession(PROJECT, { itemId: 'i1', title: 'Slack bot' });

    expect(sessionId).toBe('session-1');
    const [, input] = createProjectSession.mock.calls[0] as [string, Record<string, unknown>];
    expect(input.model_selection).toMatchObject({ kind: 'preset', model_id: 'glm-5.2' });
  });

  test('no model configured yet → no session, no toast', async () => {
    getComposerCapabilities.mockImplementation(async () => NOT_READY(null));

    expect(await startTemplateSetupSession(PROJECT, { itemId: 'i1', title: 'Slack bot' })).toBeNull();
    expect(createProjectSession).not.toHaveBeenCalled();
    expect(errorToast).not.toHaveBeenCalled();
  });
});
