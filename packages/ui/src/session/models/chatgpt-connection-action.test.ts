import { describe, expect, test } from 'bun:test';
import { chatGptActionApplies, chatGptConnectionAction } from './chatgpt-connection-action';

// The gateway's resolution errors carry `provider: ''`; only the model ids say
// the failing connection is the member’s ChatGPT subscription.
describe('chatGptConnectionAction', () => {
  test('an expired ChatGPT login asks to reconnect', () => {
    expect(chatGptConnectionAction({ code: 'provider_reauth_required', resolvedModel: 'codex/gpt-6-sol' })).toBe('reconnect');
  });

  test('a missing ChatGPT connection asks to connect', () => {
    expect(chatGptConnectionAction({ code: 'provider_not_connected', requestedModel: 'codex/gpt-6-luna' })).toBe('connect');
  });

  test('the OpenCode provider prefix still names ChatGPT', () => {
    expect(chatGptConnectionAction({ code: 'provider_reauth_required', requestedModel: 'kortix/codex/gpt-6-sol' })).toBe('reconnect');
  });

  test('the routed model wins over the requested one', () => {
    expect(chatGptConnectionAction({
      code: 'provider_not_connected', requestedModel: 'auto', resolvedModel: 'codex/gpt-6-sol',
    })).toBe('connect');
  });

  test('another provider is not a ChatGPT action', () => {
    expect(chatGptConnectionAction({ code: 'provider_not_connected', resolvedModel: 'anthropic/claude-opus-5-5' })).toBeNull();
  });

  test('another failure on a ChatGPT model is not a connection action', () => {
    expect(chatGptConnectionAction({ code: 'provider_pool_rate_limited', resolvedModel: 'codex/gpt-6-sol' })).toBeNull();
  });

  test('an agent that may not use ChatGPT is not a connection action', () => {
    // The connection exists; the agent's secret grant is what refuses it.
    expect(chatGptConnectionAction({ code: 'agent_grant_excludes', resolvedModel: 'codex/gpt-6-sol' })).toBeNull();
  });

  test('no details, no action', () => {
    expect(chatGptConnectionAction(undefined)).toBeNull();
    expect(chatGptConnectionAction(null)).toBeNull();
  });
});

// A member’s own ChatGPT account serves only that member’s private session
// (spec 2026-09-22 §2.3). The action appears only where the dialog can fix
// the failure.
describe('chatGptActionApplies', () => {
  const mine = { personalUser: 'u1', viewerId: 'u1' };

  test('connect: the viewer’s private session without a selection', () => {
    expect(chatGptActionApplies({ action: 'connect', ...mine, explicitSelection: false })).toBe(true);
  });

  test('connect: an explicit ChatGPT selection is fixed in session settings instead', () => {
    expect(chatGptActionApplies({ action: 'connect', ...mine, explicitSelection: true })).toBe(false);
  });

  test('connect: a shared session never uses a member’s own account', () => {
    expect(chatGptActionApplies({ action: 'connect', personalUser: null, viewerId: 'u1', explicitSelection: false })).toBe(false);
  });

  test('connect: another member’s private session does not use the viewer’s account', () => {
    expect(chatGptActionApplies({ action: 'connect', personalUser: 'u2', viewerId: 'u1', explicitSelection: false })).toBe(false);
  });

  test('connect: nothing is offered while the session or its selection is unknown', () => {
    expect(chatGptActionApplies({ action: 'connect', personalUser: undefined, viewerId: 'u1', explicitSelection: false })).toBe(false);
    expect(chatGptActionApplies({ action: 'connect', ...mine, explicitSelection: undefined })).toBe(false);
    expect(chatGptActionApplies({ action: 'connect', personalUser: 'u1', viewerId: undefined, explicitSelection: false })).toBe(false);
  });

  test('reconnect: the viewer’s private session, with or without a selection', () => {
    expect(chatGptActionApplies({ action: 'reconnect', ...mine, explicitSelection: false })).toBe(true);
    expect(chatGptActionApplies({ action: 'reconnect', ...mine, explicitSelection: true })).toBe(true);
    expect(chatGptActionApplies({ action: 'reconnect', ...mine, explicitSelection: undefined })).toBe(true);
  });

  test('reconnect: a shared session with a selection may name the viewer’s shared account', () => {
    expect(chatGptActionApplies({ action: 'reconnect', personalUser: null, viewerId: 'u1', explicitSelection: true })).toBe(true);
  });

  test('reconnect: a shared session without a selection runs on the project login, not an account', () => {
    expect(chatGptActionApplies({ action: 'reconnect', personalUser: null, viewerId: 'u1', explicitSelection: false })).toBe(false);
    expect(chatGptActionApplies({ action: 'reconnect', personalUser: null, viewerId: 'u1', explicitSelection: undefined })).toBe(false);
  });
});
