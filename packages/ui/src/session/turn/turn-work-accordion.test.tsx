import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { BurstSummaryTrigger } from './burst-summary-trigger';
import { TurnWorkAccordion } from './turn-work-accordion';
import { Disclosure } from '../../primitives/disclosure';
import { StepBody } from './burst-step-body';

const STEP = <div>synthetic step content</div>;

describe('TurnWorkAccordion', () => {
  const row = (durationMs: number | null, open = false) =>
    renderToStaticMarkup(<TurnWorkAccordion durationMs={durationMs} open={open} onToggle={() => {}} contentId="work" />);

  test('a closed row is one button with the label and no controlled region', () => {
    const html = row(134_000);
    expect(html).toContain('Worked for 2m 14s');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('aria-controls');
    expect(html).not.toContain('border-b');
  });

  test('an open row names the work it controls and turns its caret', () => {
    const html = row(134_000, true);
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('aria-controls="work"');
    expect(html).toContain('rotate-90');
    expect(html).toContain('border-b');
  });

  test('an unknown or sub-second duration reads "Worked"', () => {
    for (const durationMs of [null, 400]) {
      const html = row(durationMs);
      expect(html).toContain('>Worked</span>');
      expect(html).not.toContain('Worked for');
    }
  });

  test('the row caret answers its own group, never an inner burst', () => {
    const html = row(134_000);
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
  test('the burst renders the existing summary disclosure', () => {
    const marker = <StepBody step={{ kind: 'block', key: 'cp', block: { type: 'compaction', id: 'cp', summary: 'Retained synthetic context', first_kept_message_id: null } }} running={false} sessionId="synthetic" />;
    const expanded = renderToStaticMarkup(marker);
    expect(expanded).toContain('Context automatically compacted');
    expect(expanded).toContain('aria-expanded="false"');
    expect(expanded).not.toContain('Retained synthetic context');
  });
});
