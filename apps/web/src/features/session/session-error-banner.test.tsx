import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { SessionRetryDisplay, TurnErrorDisplay, describeTurnErrorRow } from './session-error-banner';

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
        defaultDetailsOpen
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

// A failed turn is a checkpoint row in the activity lane, like "Thought for
// 1s": an outline red glyph, "Stopped", the SDK's sentence, and a caret that
// opens the technical detail through the same disclosure the activity rows use.
describe('TurnErrorDisplay checkpoint row', () => {
  const sentence = 'The response from glm-5.3-flash could not be read.';
  const raw =
    'JSON parsing failed: Text: {"object":"chat.completion.chunk","model":"glm-5.3-flash"}. ' +
    'Error message: JSON Parse error';

  test('closed: Stopped and the sentence, no box, detail not rendered', () => {
    const html = renderToStaticMarkup(<TurnErrorDisplay errorText={sentence} errorRaw={raw} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain('>Stopped<');
    expect(html).toContain(sentence);
    expect(html).toContain('text-kortix-red');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('data-slot="item"');
    expect(html).not.toContain('chat.completion.chunk');
  });

  test('open: the raw text renders inside the disclosure', () => {
    const html = renderToStaticMarkup(
      <TurnErrorDisplay errorText={sentence} errorRaw={raw} defaultDetailsOpen />,
    );
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('chat.completion.chunk');
  });

  test('nothing to open: no caret button', () => {
    const html = renderToStaticMarkup(<TurnErrorDisplay errorText={sentence} />);
    expect(html).toContain(sentence);
    expect(html).not.toContain('aria-expanded');
  });

  test('the gateway suggestion stays visible while the row is closed', () => {
    const html = renderToStaticMarkup(
      <TurnErrorDisplay
        errorText="No upstream configured"
        errorDetails={{ suggestion: 'Add an openai API key in project settings, then retry.' }}
        errorRaw={raw}
      />,
    );
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('Add an openai API key in project settings, then retry.');
  });

  test('billing cards keep their boxed remedy row', () => {
    const html = renderToStaticMarkup(
      <TurnErrorDisplay errorText="The usage limit has been reached" errorRaw={raw} />,
    );
    expect(html).toContain('data-slot="item"');
    expect(html).not.toContain('chat.completion.chunk');
  });
});

describe('describeTurnErrorRow', () => {
  test('a billing sentence routes to the boxed card', () => {
    expect(describeTurnErrorRow({ text: 'The usage limit has been reached' })).toEqual({
      kind: 'billing-card',
      expandable: false,
    });
  });

  test('a checkpoint opens only when it has detail to show', () => {
    expect(describeTurnErrorRow({ text: 'Connection reset by peer' })).toEqual({
      kind: 'checkpoint',
      expandable: false,
    });
    expect(describeTurnErrorRow({ text: 'Connection reset by peer', raw: 'ECONNRESET' })).toEqual({
      kind: 'checkpoint',
      expandable: true,
    });
    expect(
      describeTurnErrorRow({ text: 'Upstream failed', gateway: { requestId: 'req_debug' } }),
    ).toEqual({ kind: 'checkpoint', expandable: true });
  });
});
