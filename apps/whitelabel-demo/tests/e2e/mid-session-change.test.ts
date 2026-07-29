import { describe, expect, test } from 'bun:test';
import {
  MID_SESSION_CAPABILITIES,
  agentSwitchRefusal,
  classifyAgentSwitch,
} from '../../src/lib/mid-session-change';

describe('what can change mid-session', () => {
  test('model, secrets and connections change; agent is per-prompt', () => {
    // Encoded so the UI cannot drift from the server contract. Secrets and
    // connections were `fixed_at_create` until `PUT .../scope` existed — the
    // old justification ("a mutable allowlist would leave the session
    // unbootable") was an argument about BOOT that had hardened into refusing
    // any change at all.
    expect(MID_SESSION_CAPABILITIES.model).toBe('changeable');
    expect(MID_SESSION_CAPABILITIES.agent).toBe('per_prompt');
    expect(MID_SESSION_CAPABILITIES.secrets).toBe('changeable');
    expect(MID_SESSION_CAPABILITIES.connections).toBe('changeable');
  });

  test('runtime_context is still fixed at create — the state must stay real', () => {
    // If nothing were frozen, `fixed_at_create` would be a dead branch the UI
    // could never render, and the next create-only field would have nowhere
    // honest to live.
    expect(MID_SESSION_CAPABILITIES.runtime_context).toBe('fixed_at_create');
  });
});

describe('classifyAgentSwitch', () => {
  test('a grant-crossing switch needs a NEW SESSION, not a retry', () => {
    // Retrying with the same agent fails forever — re-scoping cannot un-read
    // what the session's original agent already pulled into the sandbox.
    const result = classifyAgentSwitch({
      code: 'AGENT_SWITCH_REQUIRES_NEW_SESSION',
      error: 'agent switch requires a new session',
    });
    expect(result.kind).toBe('needs_new_session');
  });

  test('an unresolved grant IS worth retrying — the sandbox is fine', () => {
    const result = classifyAgentSwitch({ code: 'AGENT_SECRET_GRANT_UNRESOLVED', error: 'x' });
    expect(result.kind).toBe('grant_unresolved');
  });

  test('the two are never conflated — one is terminal, the other transient', () => {
    const terminal = classifyAgentSwitch({ code: 'AGENT_SWITCH_REQUIRES_NEW_SESSION' });
    const transient = classifyAgentSwitch({ code: 'AGENT_SECRET_GRANT_UNRESOLVED' });
    expect(terminal.kind).not.toBe(transient.kind);
  });

  test('no code means the prompt was not rejected for the agent', () => {
    expect(classifyAgentSwitch({}).kind).toBe('ok');
    expect(classifyAgentSwitch(null).kind).toBe('ok');
  });

  test('an unrecognised code degrades to a readable message', () => {
    expect(classifyAgentSwitch({ code: 'SOMETHING_ELSE', error: 'boom' })).toEqual({
      kind: 'unknown',
      message: 'boom',
    });
  });

  test('a blank server message still yields something readable', () => {
    const result = classifyAgentSwitch({ code: 'X', error: '  ' });
    // Narrow first: only the non-'ok' variants carry a message.
    expect(result.kind).toBe('unknown');
    if (result.kind !== 'ok') {
      expect(result.message).toBe('The agent could not be switched.');
    }
  });
});

describe('agentSwitchRefusal', () => {
  // The refusal is raised by the sandbox proxy on the prompt itself, so a host
  // sees a generic runtime error whose message carries the 409 body.
  const runtimeError = (body: Record<string, unknown>) => ({
    kind: 'runtime-error' as const,
    message: JSON.stringify(body),
    cause: new Error(`Failed to perform action: ${JSON.stringify(body)}`),
  });

  const REFUSAL = {
    error: 'agent switch requires a new session',
    code: 'AGENT_SWITCH_REQUIRES_NEW_SESSION',
    expected_agent: 'support',
    requested_agent: 'finance',
  };

  test('a refused switch names both agents, so the UI can say which is which', () => {
    const refusal = agentSwitchRefusal(runtimeError(REFUSAL))!;
    expect(refusal.requestedAgent).toBe('finance');
    expect(refusal.expectedAgent).toBe('support');
  });

  test('it is recognised from a STRUCTURED error body too', () => {
    // Same refusal, different envelope depending on which layer rejected it.
    const refusal = agentSwitchRefusal({
      message: 'x',
      cause: Object.assign(new Error('x'), { data: REFUSAL }),
    })!;
    expect(refusal.requestedAgent).toBe('finance');
  });

  test('an ordinary send failure is NOT offered a new session', () => {
    // Offering "start a new session" for a transient failure would throw away
    // the session over something a retry fixes.
    expect(agentSwitchRefusal({ message: 'the model timed out', cause: new Error('boom') })).toBeNull();
    expect(agentSwitchRefusal(null)).toBeNull();
  });

  test('the RETRYABLE grant failure is never mistaken for it', () => {
    expect(
      agentSwitchRefusal(runtimeError({ code: 'AGENT_SECRET_GRANT_UNRESOLVED', error: 'x' })),
    ).toBeNull();
  });

  test('a refusal without agent names still surfaces, with a usable message', () => {
    const refusal = agentSwitchRefusal(
      runtimeError({ code: 'AGENT_SWITCH_REQUIRES_NEW_SESSION', error: 'nope' }),
    )!;
    expect(refusal.requestedAgent).toBeNull();
    expect(refusal.message).toBe('nope');
  });
});
