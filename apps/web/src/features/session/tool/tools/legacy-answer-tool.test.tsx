import { TooltipProvider } from '@/components/ui/tooltip';
import type { ToolPart } from '@/ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { LEGACY_COMPLETE_PART } from '@/features/session/legacy-answer.fixture';
import { ToolSurfaceContext, type ToolSurface } from '@/features/session/tool/shared/infrastructure';
import { ToolPartRenderer } from '@/features/session/tool/tool-part-renderer';
import './question-tool';

import en from '../../../../../translations/en.json';

function render(part: unknown, surface: ToolSurface = 'inline') {
  const node: ReactNode = (
    <NextIntlClientProvider locale="en" messages={en} onError={() => {}}>
      <QueryClientProvider client={new QueryClient()}>
        <TooltipProvider>
          <ToolSurfaceContext.Provider value={surface}>
            <ToolPartRenderer part={part as ToolPart} sessionId="ses_legacy" />
          </ToolSurfaceContext.Provider>
        </TooltipProvider>
      </QueryClientProvider>
    </NextIntlClientProvider>
  );
  return renderToStaticMarkup(node);
}

describe('LegacyAnswerTool renders a legacy Suna answer like a show deliverable', () => {
  test('a completed `complete` renders its markdown answer, attachment card, and follow-ups', () => {
    const html = render(LEGACY_COMPLETE_PART);

    expect(html).toContain('data-component="legacy-answer"');
    // The answer is prose: markdown table and bold, not a collapsed tool row.
    expect(html).toContain('<table');
    expect(html).toContain('$1,722,502</strong>');
    expect(html).toContain('All four missing premiums are filled in');
    // The attachment rides through the show card, titled by its file name.
    expect(html).toContain('title="Macro_Hedge_Positions_Completed.xlsx"');
    // Follow-ups are clickable prefill rows under a translated label.
    expect(html).toContain('Suggested follow-ups');
    expect(html.match(/data-slot="legacy-follow-up"/g)).toHaveLength(2);
    expect(html).toContain('Break out the premium spend and current MTM by fund');
    // No raw JSON of the arguments leaks through a generic fallback row.
    expect(html).not.toContain('follow_up_prompts');
  });

  test('a legacy answer whose result row was lost renders the answer, not a failure card', () => {
    const html = render({
      ...LEGACY_COMPLETE_PART,
      state: {
        status: 'error',
        input: LEGACY_COMPLETE_PART.state.input,
        error: 'Legacy tool result unavailable',
        time: { start: 1, end: 1 },
      },
    });
    expect(html).toContain('data-component="legacy-answer"');
    expect(html).toContain('All four missing premiums are filled in');
    expect(html).not.toContain('Legacy tool result unavailable');
  });

  test('a live `ask` (the `question` alias) still renders the question tool', () => {
    const html = render({
      ...LEGACY_COMPLETE_PART,
      tool: 'ask',
      state: {
        ...LEGACY_COMPLETE_PART.state,
        input: { questions: [{ question: 'Pick one', options: [{ label: 'A' }] }] },
      },
    });
    expect(html).not.toContain('data-component="legacy-answer"');
  });

  test('a legacy `ask` renders the same way as `complete`', () => {
    const html = render({
      ...LEGACY_COMPLETE_PART,
      tool: 'ask',
      state: { ...LEGACY_COMPLETE_PART.state, input: { text: 'Which fund should I use?' } },
    });
    expect(html).toContain('data-component="legacy-answer"');
    expect(html).toContain('Which fund should I use?');
    expect(html).not.toContain('legacy-follow-up');
  });

  test('the panel surface shows the answer without composer follow-ups', () => {
    const html = render(LEGACY_COMPLETE_PART, 'panel');
    expect(html).toContain('All four missing premiums are filled in');
    expect(html).not.toContain('legacy-follow-up');
  });

  test('a `complete` call without an answer payload falls back to the generic row', () => {
    const html = render({
      ...LEGACY_COMPLETE_PART,
      state: { ...LEGACY_COMPLETE_PART.state, input: { task_id: 't1' } },
    });
    expect(html).not.toContain('data-component="legacy-answer"');
  });

  test('an errored `complete` without an answer payload keeps the failure card', () => {
    const html = render({
      ...LEGACY_COMPLETE_PART,
      state: { status: 'error', input: {}, error: 'boom', time: { start: 1, end: 1 } },
    });
    expect(html).not.toContain('data-component="legacy-answer"');
    expect(html).toContain('data-tone="failed"');
  });
});
