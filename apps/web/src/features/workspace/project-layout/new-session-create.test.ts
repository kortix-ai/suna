import { describe, expect, it } from 'bun:test';

import { buildNewSessionCreateInput, resolveNewSessionAgent } from './new-session-create';

describe('buildNewSessionCreateInput', () => {
  it('binds the picked agent as agent_name so it matches the first prompt', () => {
    // The whole bug: the composer sends agent="veyris" on the first prompt, so
    // the session MUST be created bound to "veyris" — otherwise the proxy 409s
    // (AGENT_SWITCH_REQUIRES_NEW_SESSION) and the task never starts.
    expect(buildNewSessionCreateInput({ agent: 'veyris' })).toEqual({
      agent_name: 'veyris',
    });
  });

  it('carries the sandbox slug through alongside the agent', () => {
    expect(buildNewSessionCreateInput({ agent: 'builder', sandbox_slug: 'node22' })).toEqual({
      agent_name: 'builder',
      sandbox_slug: 'node22',
    });
  });

  it('applies a harness-native model at session launch', () => {
    expect(
      buildNewSessionCreateInput({ agent: 'codex', runtimeModel: ' openai/gpt-5.4 ' }),
    ).toEqual({ agent_name: 'codex', runtime_model: 'openai/gpt-5.4' });
  });

  it('binds only the sandbox slug when no agent is picked', () => {
    expect(buildNewSessionCreateInput({ sandbox_slug: 'node22' })).toEqual({
      sandbox_slug: 'node22',
    });
  });

  it('returns undefined when there is nothing to override', () => {
    // No agent and the default sandbox → omit the create overrides entirely.
    expect(buildNewSessionCreateInput({})).toBeUndefined();
    expect(buildNewSessionCreateInput()).toBeUndefined();
  });

  it('ignores an empty-string agent (never binds agent_name="")', () => {
    // An empty agent must NOT become agent_name:"" — that would mismatch the
    // proxy's `?? "default"` and 409 the first prompt.
    expect(buildNewSessionCreateInput({ agent: '' })).toBeUndefined();
  });
});

describe('resolveNewSessionAgent', () => {
  const config = {
    runtime_default_agent: 'kortix',
    agents: [{ name: 'reviewer' }, { name: 'disabled', enabled: false }],
  };

  it('preserves an explicit picker choice', () => {
    expect(resolveNewSessionAgent(config, 'reviewer')).toBe('reviewer');
  });

  it('uses the configured project default', () => {
    expect(resolveNewSessionAgent(config)).toBe('kortix');
  });

  it('does not override the project default just because it is absent from a stale agent list', () => {
    expect(resolveNewSessionAgent({ ...config, agents: [{ name: 'reviewer' }] })).toBe('kortix');
  });

  it('keeps legacy declared-agent projects runnable when their default is missing', () => {
    expect(resolveNewSessionAgent({ ...config, runtime_default_agent: null })).toBe('reviewer');
  });

  it('does not select disabled or absent agents', () => {
    expect(
      resolveNewSessionAgent({
        runtime_default_agent: null,
        agents: [{ name: 'x', enabled: false }],
      }),
    ).toBeUndefined();
  });
});
