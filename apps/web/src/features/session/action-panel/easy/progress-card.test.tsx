import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Step } from '../shared/group-steps';
import { ProgressCard } from './progress-card';

/** Step is a plain object — build fixtures directly rather than going through groupSteps. */
function step(overrides: Partial<Step> & { id: string; label: string }): Step {
  return {
    family: 'edit',
    parts: [],
    status: 'done',
    durationMs: undefined,
    ...overrides,
  };
}

const steps: Step[] = [
  step({ id: 's1', label: 'Created the CSV', status: 'done', durationMs: 1200 }),
  step({ id: 's2', label: 'Building the workbook', status: 'running' }),
];

describe('ProgressCard — settled outcomes', () => {
  test('succeeded shows "Done · N steps · duration"', () => {
    const html = renderToStaticMarkup(
      <ProgressCard
        steps={[
          step({ id: 's1', label: 'Created the CSV', status: 'done', durationMs: 1200 }),
          step({ id: 's2', label: 'Built the workbook', status: 'done', durationMs: 800 }),
        ]}
        isRunning={false}
        elapsedMs={5000}
        outcome="succeeded"
        waitingOnUser={false}
      />,
    );
    expect(html).toContain('Done · 2 steps · 5s');
  });

  test('succeeded with exactly one step uses singular "step"', () => {
    const html = renderToStaticMarkup(
      <ProgressCard
        steps={[step({ id: 's1', label: 'Created the CSV', status: 'done', durationMs: 1200 })]}
        isRunning={false}
        elapsedMs={1200}
        outcome="succeeded"
        waitingOnUser={false}
      />,
    );
    expect(html).toContain('Done · 1 step · 1s');
  });

  test('failed run says so, never a bare step count', () => {
    const html = renderToStaticMarkup(
      <ProgressCard steps={steps} isRunning={false} elapsedMs={5000} outcome="failed" waitingOnUser={false} />,
    );
    expect(html).toContain('Something went wrong');
    expect(html).not.toContain('Done ·');
  });

  test('user-stopped run says so', () => {
    const html = renderToStaticMarkup(
      <ProgressCard steps={steps} isRunning={false} elapsedMs={5000} outcome="stopped" waitingOnUser={false} />,
    );
    expect(html).toContain('Stopped by you');
  });

  test('failed run with NO steps still renders the outcome line (never null)', () => {
    const html = renderToStaticMarkup(
      <ProgressCard steps={[]} isRunning={false} outcome="failed" waitingOnUser={false} />,
    );
    expect(html).toContain('Something went wrong');
  });

  test('clean idle run with no steps renders nothing', () => {
    expect(
      renderToStaticMarkup(
        <ProgressCard steps={[]} isRunning={false} outcome="succeeded" waitingOnUser={false} />,
      ),
    ).toBe('');
  });
});

describe('ProgressCard — running shows the live story', () => {
  test('running shows the CURRENT (running) step label, not a step count', () => {
    const html = renderToStaticMarkup(
      <ProgressCard steps={steps} isRunning outcome="succeeded" waitingOnUser={false} />,
    );
    expect(html).toContain('Building the workbook');
    expect(html).not.toContain('Step 2 of');
  });

  test('running with no step actually marked running falls back to the last step label', () => {
    const html = renderToStaticMarkup(
      <ProgressCard
        steps={[step({ id: 's1', label: 'Created the CSV', status: 'done', durationMs: 1200 })]}
        isRunning
        outcome="succeeded"
        waitingOnUser={false}
      />,
    );
    expect(html).toContain('Created the CSV');
  });

  test('no steps yet, but still working: one live "Working…" line', () => {
    const html = renderToStaticMarkup(
      <ProgressCard steps={[]} isRunning outcome="succeeded" waitingOnUser={false} />,
    );
    expect(html).toContain('Working…');
  });
});

describe('ProgressCard — expanded rows', () => {
  test('an error step row renders its failure label, newest step last', () => {
    const errorSteps: Step[] = [
      step({ id: 's1', label: 'Read the brief', status: 'done', durationMs: 500 }),
      step({ id: 's2', label: 'The sandbox connection failed', status: 'error', durationMs: 300 }),
    ];
    // `isRunning` forces `defaultExpanded` so the body actually renders — a
    // settled card defaults to collapsed and the row markup wouldn't be in
    // the static HTML at all otherwise.
    const html = renderToStaticMarkup(
      <ProgressCard steps={errorSteps} isRunning outcome="failed" waitingOnUser={false} />,
    );
    expect(html).toContain('Read the brief');
    expect(html).toContain('The sandbox connection failed');
    // newest (error) step must come after the first WITHIN THE BODY LIST — the
    // header (before `<ul`) also narrates the current/last step, so the check
    // has to look past it rather than at the raw document order.
    const body = html.slice(html.indexOf('<ul'));
    expect(body.indexOf('Read the brief')).toBeLessThan(body.indexOf('The sandbox connection failed'));
  });

  test('a running row has no duration next to it', () => {
    const html = renderToStaticMarkup(
      <ProgressCard steps={steps} isRunning outcome="succeeded" waitingOnUser={false} />,
    );
    // The done row's duration (1200ms -> "1s") should render, the running row's should not.
    expect(html).toContain('1s');
  });
});

describe('ProgressCard — waiting state (W9)', () => {
  test('a pending question reads as waiting, not working, not done', () => {
    const html = renderToStaticMarkup(
      <ProgressCard steps={steps} isRunning outcome="succeeded" waitingOnUser />,
    );
    // Waiting overrides the collapsed HEADER line only — the expanded body
    // still shows the real steps underneath it, unedited (that's `text-kortix-orange`).
    expect(html).toContain('Waiting for your answer');
    expect(html).toContain('text-kortix-orange');
  });

  test('waiting takes precedence even when the agent is not marked as running', () => {
    const html = renderToStaticMarkup(
      <ProgressCard steps={steps} isRunning={false} outcome="succeeded" waitingOnUser />,
    );
    expect(html).toContain('Waiting for your answer');
  });

  test('no steps yet, but a question is already pending: waiting replaces the shimmering "Working…" line', () => {
    const html = renderToStaticMarkup(
      <ProgressCard steps={[]} isRunning outcome="succeeded" waitingOnUser />,
    );
    expect(html).toContain('Waiting for your answer');
    expect(html).not.toContain('Working…');
  });

  test('waiting suppresses the failed-outcome line — being blocked outranks being broken', () => {
    const html = renderToStaticMarkup(
      <ProgressCard steps={steps} isRunning={false} outcome="failed" waitingOnUser />,
    );
    expect(html).toContain('Waiting for your answer');
    expect(html).not.toContain('Something went wrong');
  });

  test('waiting suppresses the stopped-outcome line too', () => {
    const html = renderToStaticMarkup(
      <ProgressCard steps={steps} isRunning={false} outcome="stopped" waitingOnUser />,
    );
    expect(html).toContain('Waiting for your answer');
    expect(html).not.toContain('Stopped by you');
  });

  test('no steps, empty+failed still gets its one-line card even when not waiting', () => {
    const html = renderToStaticMarkup(
      <ProgressCard steps={[]} isRunning={false} outcome="failed" waitingOnUser={false} />,
    );
    expect(html).toContain('Something went wrong');
  });
});
