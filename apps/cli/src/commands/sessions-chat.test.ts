import { describe, expect, test } from 'bun:test';
import type { AssistantMessage, MessageWithParts } from '@kortix/sdk';
import { printMessage } from './sessions-chat.ts';

/** `printMessage` writes straight to stdout; swap the writer for the test. */
function render(msg: MessageWithParts): string {
  const out: string[] = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk) => {
    out.push(String(chunk));
    return true;
  };
  try {
    printMessage(msg);
  } finally {
    process.stdout.write = original;
  }
  return out.join('');
}

/** A failed assistant turn: no text parts, the error on `info.error`. */
const failedTurn = (error: AssistantMessage['error']): MessageWithParts => ({
  info: {
    id: 'msg_test',
    sessionID: 'ses_test',
    role: 'assistant',
    time: { created: 1_759_500_000_000 },
    error,
    modelID: 'premium-model',
    providerID: 'kortix',
    mode: 'build',
    agent: 'build',
    path: { cwd: '/w', root: '/w' },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  },
  parts: [],
});

describe('printMessage — a failed turn shows the real failure reason', () => {
  test('an APIError carries the gateway body in responseBody; its message wins over the status text', () => {
    const out = render(
      failedTurn({
        name: 'APIError',
        data: {
          message: 'Bad Request',
          statusCode: 402,
          isRetryable: false,
          responseBody:
            '{"error":"plan_upgrade_required","code":402,"message":"\\"premium-model\\" requires a paid plan.","provider":"kortix","suggestion":"Upgrade your plan or pick a free model."}',
        },
      }),
    );
    expect(out).toContain('"premium-model" requires a paid plan.');
    expect(out).not.toContain('error: unknown');
  });

  test('an UnknownError whose data.message is a JSON body unwraps to the sentence', () => {
    const out = render(
      failedTurn({
        name: 'UnknownError',
        data: { message: '{"message":"Provided authentication token is expired.","code":401}' },
      }),
    );
    expect(out).toContain('Provided authentication token is expired.');
    expect(out).not.toContain('error: unknown');
  });

  test('a ProviderAuthError shows its plain message', () => {
    const out = render(
      failedTurn({
        name: 'ProviderAuthError',
        data: { providerID: 'anthropic', message: 'No API key found for provider "anthropic".' },
      }),
    );
    expect(out).toContain('No API key found for provider "anthropic".');
    expect(out).not.toContain('error: unknown');
  });

  test('an error with no recoverable text degrades to the generic sentence, never "unknown"', () => {
    const out = render(failedTurn({ name: 'MessageOutputLengthError', data: {} }));
    expect(out).toContain('An error occurred');
    expect(out).not.toContain('error: unknown');
  });
});
