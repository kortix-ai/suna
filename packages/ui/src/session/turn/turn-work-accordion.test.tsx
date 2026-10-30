import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { BurstSummaryTrigger } from './burst-summary-trigger';
import { TurnWorkAccordion } from './turn-work-accordion';
import { Disclosure } from '../../primitives/disclosure';
import { StepBody } from './burst-step-body';

const STEP = <div>synthetic step content</div>;

describe('TurnWorkAccordion', () => {
  test('a settled turn paints one collapsed "Worked for" row and no step content', () => {
    const html = renderToStaticMarkup(
      <TurnWorkAccordion durationMs={134_000}>
        {STEP}
      </TurnWorkAccordion>,
    );
    expect(html).toContain('Worked for 2m 14s');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('data-state="closed"');
    expect(html).not.toContain('synthetic step content');
  });

  test('an unknown or sub-second duration reads "Worked"', () => {
    for (const durationMs of [null, 400]) {
      const html = renderToStaticMarkup(
        <TurnWorkAccordion durationMs={durationMs}>
          {STEP}
        </TurnWorkAccordion>,
      );
      expect(html).toContain('>Worked</span>');
      expect(html).not.toContain('Worked for');
    }
  });



  test('the row caret answers its own group, never an inner burst', () => {
    const html = renderToStaticMarkup(
      <TurnWorkAccordion durationMs={134_000}>
        {STEP}
      </TurnWorkAccordion>,
    );
    expect(html).toContain('group/work');
    expect(html).toContain('group-data-[state=open]/work:rotate-90');
    expect(html).toContain('group-hover/work:text-muted-foreground/70');
    expect(html).not.toContain('/burst');
  });
});

describe('BurstSummaryTrigger scope', () => {
  test('defaults to the burst group', () => {
    const html = renderToStaticMarkup(
      <Disclosure open={false} onOpenChange={() => {}}>
        <BurstSummaryTrigger bare={false} running={false} title="Completed 2 steps" />
        <div />
      </Disclosure>,
    );
    expect(html).toContain('group-data-[state=open]/burst:rotate-90');
    expect(html).not.toContain('/work');
  });
});

describe('compaction inside Worked (KRTX-3034)', () => {
  test('the existing fold hides the marker until expanded, and the burst renders the existing summary disclosure', () => {
    const marker = <StepBody step={{ kind: 'block', key: 'cp', block: { type: 'compaction', id: 'cp', summary: 'Retained synthetic context', first_kept_message_id: null } }} running={false} sessionId="synthetic" />;
    const closed = renderToStaticMarkup(<TurnWorkAccordion durationMs={null}>{marker}</TurnWorkAccordion>);
    expect(closed).toContain('>Worked</span>');
    expect(closed).not.toContain('Context automatically compacted');
    const expanded = renderToStaticMarkup(marker);
    expect(expanded).toContain('Context automatically compacted');
    expect(expanded).toContain('aria-expanded="false"');
    expect(expanded).not.toContain('Retained synthetic context');
  });
});
