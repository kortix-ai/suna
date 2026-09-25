import { describe, expect, test } from 'bun:test';
import { chatGptConnectionAction } from './chatgpt-connection-action';

// The gateway's resolution errors carry `provider: ''`; only the model ids say
// the failing connection is the member's ChatGPT subscription.
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

  test('no details, no action', () => {
    expect(chatGptConnectionAction(undefined)).toBeNull();
    expect(chatGptConnectionAction(null)).toBeNull();
  });
});
