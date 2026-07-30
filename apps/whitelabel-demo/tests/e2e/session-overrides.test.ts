import { describe, expect, test } from 'bun:test';
import {
  NO_OVERRIDES,
  buildSessionCreateInput,
} from '../../src/lib/session-overrides';

const SESSION_ID = '00000000-0000-4000-8000-000000000001';

describe('buildSessionCreateInput', () => {
  test('an untouched dialog sends exactly what the bare create sent before', () => {
    // The overrides are opt-in. If this ever grows a field, every existing
    // session shape changes silently — which is the failure this test exists
    // to catch.
    expect(
      buildSessionCreateInput(NO_OVERRIDES, { sessionId: SESSION_ID }),
    ).toEqual({
      session_id: SESSION_ID,
    });
  });

  test('a narrowed allowlist is sent as `secrets`', () => {
    const input = buildSessionCreateInput(
      { ...NO_OVERRIDES, secrets: ['STRIPE_KEY', 'GMAIL_TOKEN'] },
      { sessionId: SESSION_ID },
    );
    expect(input.secrets).toEqual(['STRIPE_KEY', 'GMAIL_TOKEN']);
  });

  test('an EMPTY allowlist is sent — "zero secrets" is a choice, not an absence', () => {
    const input = buildSessionCreateInput(
      { ...NO_OVERRIDES, secrets: [] },
      { sessionId: SESSION_ID },
    );
    expect(input.secrets).toEqual([]);
  });

  test('no allowlist means the field is absent, not an empty array', () => {
    // `secrets: []` would boot a sandbox with no project secrets at all — the
    // opposite of "leave it alone".
    const input = buildSessionCreateInput(NO_OVERRIDES, {
      sessionId: SESSION_ID,
    });
    expect('secrets' in input).toBe(false);
  });

  test('a binding is keyed by the alias that was chosen', () => {
    const input = buildSessionCreateInput(
      { ...NO_OVERRIDES, bindings: { slack: 'prof_9' } },
      { sessionId: SESSION_ID },
    );
    // The alias used to be hardcoded to one connector, so binding anything
    // else silently bound the wrong one.
    expect(input.connector_bindings).toEqual({
      slack: { authorization_id: 'prof_9' },
    });
    expect(Object.keys(input.connector_bindings ?? {})).not.toContain('gmail');
  });

  test('several aliases can be bound in one create', () => {
    const input = buildSessionCreateInput(
      { ...NO_OVERRIDES, bindings: { slack: 'prof_9', notion: 'prof_3' } },
      { sessionId: SESSION_ID },
    );
    expect(input.connector_bindings).toEqual({
      slack: { authorization_id: 'prof_9' },
      notion: { authorization_id: 'prof_3' },
    });
  });

  test('binding one alias keeps the project default for every other one', () => {
    // Without inherit_unbound, binding ANY alias switches all the others off
    // their project default — picking one connection would unplug the rest.
    const input = buildSessionCreateInput(
      { ...NO_OVERRIDES, bindings: { slack: 'prof_9' } },
      { sessionId: SESSION_ID },
    );
    expect(input.inherit_unbound).toBe(true);
  });

  test('no bindings means no connector fields at all', () => {
    const input = buildSessionCreateInput(NO_OVERRIDES, {
      sessionId: SESSION_ID,
    });
    expect('connector_bindings' in input).toBe(false);
    expect('inherit_unbound' in input).toBe(false);
    expect('metadata' in input).toBe(false);
  });

  test('the agent is sent only when one was picked', () => {
    expect(
      buildSessionCreateInput(
        { ...NO_OVERRIDES, agent: 'support' },
        { sessionId: SESSION_ID },
      ).agent_name,
    ).toBe('support');
    expect(
      'agent_name' in
        buildSessionCreateInput(NO_OVERRIDES, { sessionId: SESSION_ID }),
    ).toBe(false);
  });

  test('the "default" sandbox template is not a template override', () => {
    const input = buildSessionCreateInput(NO_OVERRIDES, {
      sessionId: SESSION_ID,
      sandboxSlug: 'default',
    });
    expect('sandbox_slug' in input).toBe(false);
  });

  test('everything at once composes into one body', () => {
    const input = buildSessionCreateInput(
      {
        agent: 'support',
        secrets: ['STRIPE_KEY'],
        bindings: { slack: 'prof_9' },
        runtimeContext: null,
      },
      {
        sessionId: SESSION_ID,
        name: 'Refund a customer',
        sandboxSlug: 'python',
      },
    );
    expect(input).toEqual({
      session_id: SESSION_ID,
      name: 'Refund a customer',
      sandbox_slug: 'python',
      agent_name: 'support',
      secrets: ['STRIPE_KEY'],
      connector_bindings: { slack: { authorization_id: 'prof_9' } },
      inherit_unbound: true,
    });
  });
});

describe('runtime_context', () => {
  test('is sent when set — the one documented override the demo could not exercise', () => {
    const body = buildSessionCreateInput(
      { ...NO_OVERRIDES, runtimeContext: { plan: 'pro', locale: 'en-GB' } },
      { sessionId: 's1' },
    );
    expect(body.runtime_context).toEqual({ plan: 'pro', locale: 'en-GB' });
  });

  test('is OMITTED when unset, so an untouched session is byte-identical to before', () => {
    const body = buildSessionCreateInput(NO_OVERRIDES, { sessionId: 's1' });
    expect('runtime_context' in body).toBe(false);
  });

  test('an EMPTY map is omitted too — sending {} would claim context that is not there', () => {
    const body = buildSessionCreateInput(
      { ...NO_OVERRIDES, runtimeContext: {} },
      { sessionId: 's1' },
    );
    expect('runtime_context' in body).toBe(false);
  });
});
