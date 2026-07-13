import { describe, expect, it } from 'bun:test';

import { buildNewSessionCreateInput } from './new-session-create';

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
    expect(
      buildNewSessionCreateInput({ agent: 'builder', sandbox_slug: 'node22' }),
    ).toEqual({ agent_name: 'builder', sandbox_slug: 'node22' });
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
