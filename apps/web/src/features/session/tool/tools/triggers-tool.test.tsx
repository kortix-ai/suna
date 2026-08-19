import type { ToolPart } from '@/ui';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { ToolSurfaceContext } from '@/features/session/tool/shared/infrastructure';
import { TriggersTool } from './triggers-tool';

// Task 20: creating a trigger answers with the trigger. The prompt it will run
// with is a paragraph of instructions and used to sit open under it.

function makePart(input: Record<string, unknown>, output: string): ToolPart {
  return {
    type: 'tool',
    tool: 'trigger_create',
    callID: 'call-1',
    state: { status: 'completed', input, output, metadata: {} },
  } as unknown as ToolPart;
}

const CREATE_PART = makePart(
  {
    action: 'create',
    name: 'daily-standup',
    source_type: 'cron',
    prompt: 'Summarize what the team shipped yesterday and post it to Slack.',
  },
  'Trigger created: daily-standup\n[active] daily-standup | cron: 0 9 * * * | kortix → kortix | last_run: never',
);

describe('TriggersTool', () => {
  test('the trigger row stays visible; its prompt folds', () => {
    const html = renderToStaticMarkup(<TriggersTool part={CREATE_PART} defaultOpen />);

    // The status line: which trigger, on what schedule, active or not.
    expect(html).toContain('daily-standup');
    expect(html).toContain('0 9 * * *');
    expect(html).toContain('active');

    expect(html).toContain('Prompt');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('Summarize what the team shipped');
  });

  test('panel surface: same fold once the row is open', () => {
    const html = renderToStaticMarkup(
      <ToolSurfaceContext.Provider value="panel">
        <TriggersTool part={CREATE_PART} defaultOpen />
      </ToolSurfaceContext.Provider>,
    );

    expect(html).toContain('daily-standup');
    expect(html).not.toContain('Summarize what the team shipped');
  });
});
