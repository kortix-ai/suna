import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { TodoItem } from '../../tool/shared/todo-helpers';
import { ProgressCard } from './progress-card';

const plan: TodoItem[] = [
  { content: 'Create the CSV', status: 'completed' },
  { content: 'Build the workbook', status: 'in_progress' },
  { content: 'Export the PDF', status: 'pending' },
] as TodoItem[];

describe('ProgressCard outcomes (W7)', () => {
  test('settled failed run says so, never a bare partial-success count', () => {
    const html = renderToStaticMarkup(
      <ProgressCard plan={plan} isRunning={false} elapsedMs={5000} outcome="failed" />,
    );
    expect(html).toContain('Something went wrong');
  });

  test('user-stopped run says so', () => {
    const html = renderToStaticMarkup(
      <ProgressCard plan={plan} isRunning={false} elapsedMs={5000} outcome="stopped" />,
    );
    expect(html).toContain('Stopped by you');
  });

  test('failed run with NO plan still renders the outcome line (never null)', () => {
    const html = renderToStaticMarkup(
      <ProgressCard plan={[]} isRunning={false} outcome="failed" />,
    );
    expect(html).toContain('Something went wrong');
  });

  test('clean idle run with no plan still renders nothing', () => {
    expect(
      renderToStaticMarkup(<ProgressCard plan={[]} isRunning={false} outcome="succeeded" />),
    ).toBe('');
  });
});

describe('ProgressCard step counter (W10)', () => {
  test('running with a plan shows the position', () => {
    const html = renderToStaticMarkup(
      <ProgressCard plan={plan} isRunning outcome="succeeded" />,
    );
    expect(html).toContain('Step 2 of 3');
    expect(html).toContain('Build the workbook');
  });
});
