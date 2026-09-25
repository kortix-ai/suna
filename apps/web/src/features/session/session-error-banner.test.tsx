import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { SessionRetryDisplay, TurnErrorDisplay } from './session-error-banner';

describe('SessionRetryDisplay', () => {
  test('renders the gateway source, request id, and ordered candidate failures', () => {
    const html = renderToStaticMarkup(
      <SessionRetryDisplay
        message="All upstream candidates failed"
        attempt={1}
        secondsLeft={26}
        details={{
          message: 'All upstream candidates failed',
          provider: 'openrouter',
          code: 'upstream_error',
          requestId: 'req_incident',
          attemptFailures: [
            {
              attempt: 1,
              provider: 'openai-codex',
              routeModel: 'codex/gpt-5.6-sol',
              resolvedModel: 'gpt-5.6-sol',
              stage: 'stream_error',
              status: 400,
              code: 'context_length_exceeded',
              message: 'Your input exceeds the context window of this model.',
            },
            {
              attempt: 2,
              provider: 'openrouter',
              routeModel: 'glm-5.3-flash',
              resolvedModel: 'z-ai/glm-5.3-flash',
              stage: 'stream_probe',
              code: 'stream_probe_timeout',
              message: 'No bytes within 60 seconds.',
            },
          ],
        }}
      />,
    );

    expect(html).toContain('Retrying in 26s');
    expect(html).toContain('openrouter · upstream_error · req_incident');
    expect(html).toContain('openai-codex/gpt-5.6-sol');
    expect(html).toContain('route codex/gpt-5.6-sol');
    expect(html).toContain('HTTP 400');
    expect(html).toContain('context_length_exceeded');
    expect(html).toContain('openrouter/z-ai/glm-5.3-flash');
    expect(html).toContain('stream_probe_timeout');
  });

  test('keeps the legacy message-only retry surface', () => {
    const html = renderToStaticMarkup(
      <SessionRetryDisplay message="Bad Gateway" attempt={2} secondsLeft={0} />,
    );
    expect(html).toContain('Retrying now');
    expect(html).toContain('Bad Gateway');
  });

  test('renders the ordered failure chain after the retry becomes a terminal turn error', () => {
    const html = renderToStaticMarkup(
      <TurnErrorDisplay
        errorText="All upstream candidates failed"
        errorDetails={{
          provider: 'openrouter',
          code: 'upstream_error',
          requestId: 'req_terminal',
          attemptFailures: [
            {
              attempt: 1,
              provider: 'openai-codex',
              routeModel: 'codex/gpt-5.6-sol',
              resolvedModel: 'gpt-5.6-sol',
              stage: 'stream_error',
              status: 400,
              code: 'context_length_exceeded',
              message: 'Your input exceeds the context window of this model.',
            },
          ],
        }}
      />,
    );

    expect(html).toContain('upstream_error');
    expect(html).toContain('req_terminal');
    expect(html).toContain('openai-codex/gpt-5.6-sol');
    expect(html).toContain('HTTP 400');
    expect(html).toContain('context_length_exceeded');
  });
});

// Off a session route there is no session to fix, so a ChatGPT connection
// failure keeps the plain row: message, suggestion, code, and no button. The
// session-aware action is asserted in the browser (spec 30).
describe('TurnErrorDisplay — ChatGPT connection failures', () => {
  test('stays informational without a session route', () => {
    const html = renderToStaticMarkup(
      <TurnErrorDisplay
        errorText="Your ChatGPT connection needs reconnection."
        errorDetails={{
          provider: '',
          code: 'provider_reauth_required',
          requestId: 'req_chatgpt',
          suggestion: 'Reconnect your ChatGPT account in Models, then retry.',
          requestedModel: 'codex/gpt-6-sol',
          resolvedModel: 'codex/gpt-6-sol',
        }}
      />,
    );

    expect(html).toContain('Your ChatGPT connection needs reconnection.');
    expect(html).toContain('Reconnect your ChatGPT account in Models, then retry.');
    expect(html).toContain('provider_reauth_required');
    expect(html).not.toContain('<button');
  });
});

// Persisted on a local stack as OpenCode `UnknownError.data.message`:
// `{"message":"The usage limit has been reached","code":429}`. Once the SDK
// unwraps that to the sentence, it is a usage stop the user can lift, so it
// must reach the upgrade card and not the generic failure row.
describe('TurnErrorDisplay routes a usage-limit sentence to the upgrade card', () => {
  test('"The usage limit has been reached" renders Upgrade plan', () => {
    const html = renderToStaticMarkup(
      <TurnErrorDisplay errorText="The usage limit has been reached" />,
    );
    expect(html).toContain('Upgrade plan');
    expect(html).toContain('The usage limit has been reached');
  });
});
