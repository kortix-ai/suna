import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { SessionRetryDisplay, TurnErrorDisplay } from './session-error-banner';

const failures = [
  { attempt: 1, provider: 'first', routeModel: 'model-a', resolvedModel: 'model-a', stage: 'stream_error', code: 'unavailable', message: 'First failed', status: 503 },
  { attempt: 2, provider: 'second', routeModel: 'model-b', resolvedModel: 'model-b', stage: 'stream_probe', code: 'timeout', message: 'Second failed' },
];

describe('failure chain rendering', () => {
  test('retry and terminal errors retain ordered diagnostics and their distinct list styles', () => {
    const retry = renderToStaticMarkup(
      <SessionRetryDisplay message="Retry" attempt={1} secondsLeft={2} details={{ message: 'Upstream failed', attemptFailures: failures }} />,
    );
    const terminal = renderToStaticMarkup(
      <TurnErrorDisplay errorText="Upstream failed" errorDetails={{ attemptFailures: failures }} defaultDetailsOpen />,
    );
    for (const html of [retry, terminal]) {
      expect(html.match(/<ol\b/g)).toHaveLength(1);
      expect(html.indexOf('First failed')).toBeLessThan(html.indexOf('Second failed'));
      expect(html).toContain('HTTP 503');
      expect(html).toContain('unavailable');
      expect(html).toContain('timeout');
      expect(html).not.toContain('HTTP undefined');
    }
    expect(retry).toContain('text-muted-foreground mt-1 list-decimal space-y-1 pl-4 wrap-anywhere');
    expect(terminal).toContain('text-muted-foreground list-decimal space-y-1 pl-4 text-xs wrap-anywhere');
  });

  test('neither surface renders an empty list', () => {
    expect(renderToStaticMarkup(<SessionRetryDisplay message="Retry" attempt={1} secondsLeft={2} />)).not.toContain('<ol');
    expect(renderToStaticMarkup(<TurnErrorDisplay errorText="Upstream failed" />)).not.toContain('<ol');
  });
});
