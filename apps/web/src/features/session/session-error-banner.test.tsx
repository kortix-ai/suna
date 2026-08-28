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
