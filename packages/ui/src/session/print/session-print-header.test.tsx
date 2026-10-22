import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { UiProvider } from '../../providers/ui-provider';
import { SessionPrintHeader } from './session-print-header';

const now = new Date('2026-10-21T07:41:00Z');

describe('SessionPrintHeader', () => {
  test('names the agent with the host agentLabels entry, not the raw agent name', () => {
    const html = renderToStaticMarkup(
      <UiProvider config={{ agentLabels: { 'lumen-f-k17': 'Counsel' } }}>
        <SessionPrintHeader title="Cap check memo" agentName="lumen-f-k17" now={now} />
      </UiProvider>,
    );
    expect(html).toContain('Counsel · ');
    expect(html).not.toContain('lumen-f-k17');
  });

  test('without a label it prints the agent name as given', () => {
    const html = renderToStaticMarkup(<SessionPrintHeader title="T" agentName="build" now={now} />);
    expect(html).toContain('build · ');
  });
});
