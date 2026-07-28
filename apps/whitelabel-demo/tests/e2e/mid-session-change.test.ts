import { describe, expect, test } from 'bun:test';
import { MID_SESSION_CAPABILITIES, classifyAgentSwitch } from '../../src/lib/mid-session-change';

describe('what can change mid-session', () => {
  test('model changes, agent is per-prompt, secrets are fixed at create', () => {
    // Encoded so the UI cannot drift from the server contract: offering a
    // secrets control would be offering something that cannot work.
    expect(MID_SESSION_CAPABILITIES.model).toBe('changeable');
    expect(MID_SESSION_CAPABILITIES.agent).toBe('per_prompt');
    expect(MID_SESSION_CAPABILITIES.secrets).toBe('fixed_at_create');
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
