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
          provider: 'aster',
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
              provider: 'aster',
              routeModel: 'glm-5.2',
              resolvedModel: 'glm-5.2',
              stage: 'stream_probe',
              code: 'stream_probe_timeout',
              message: 'No bytes within 60 seconds.',
            },
          ],
        }}
      />,
    );

    expect(html).toContain('Retrying in 26s');
    expect(html).toContain('aster · upstream_error · req_incident');
    expect(html).toContain('openai-codex/gpt-5.6-sol');
    expect(html).toContain('route codex/gpt-5.6-sol');
    expect(html).toContain('HTTP 400');
    expect(html).toContain('context_length_exceeded');
    expect(html).toContain('aster/glm-5.2');
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
          provider: 'aster',
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

// ============================================================================
// ModelNotFound for a managed (`kortix/…`) model — the one failure the sandbox
// repairs by itself. Payload is verbatim from a live sandbox: opencode names
// the frame `UnknownError`, so only the message text identifies it.
// ============================================================================

describe('TurnErrorDisplay — managed model not registered yet', () => {
  const modelNotFound =
    'Model not found: kortix/grok-4.6. Did you mean: 302ai/gemini-2.5-flash-nothink, abliteration-ai/abliterated-model?';

  test('keeps the runtime text and adds the retry hint beneath it', () => {
    const html = renderToStaticMarkup(<TurnErrorDisplay errorText={modelNotFound} />);
    expect(html).toContain('Model not found: kortix/grok-4.6');
    expect(html).toContain(
      'This sandbox is registering the model now — send your message again in a few seconds.',
    );
  });

  test('no hint for a model this platform does not serve — retrying cannot fix that', () => {
    const html = renderToStaticMarkup(
      <TurnErrorDisplay errorText="Model not found: openai/gpt-9. Did you mean: openai/gpt-4.1?" />,
    );
    expect(html).toContain('Model not found: openai/gpt-9');
    expect(html).not.toContain('registering the model now');
  });

  test('no hint on any other failure', () => {
    const html = renderToStaticMarkup(<TurnErrorDisplay errorText="Bad Gateway" />);
    expect(html).toContain('Bad Gateway');
    expect(html).not.toContain('registering the model now');
  });
});
