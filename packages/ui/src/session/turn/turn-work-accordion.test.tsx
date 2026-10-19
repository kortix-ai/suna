import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { BurstSummaryTrigger } from './burst-summary-trigger';
import { TurnWorkAccordion } from './turn-work-accordion';
import { Disclosure } from '../../components/ui/disclosure';

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
