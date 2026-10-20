import { describe, expect, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SessionModelUsage } from '@kortix/sdk';

import messages from '../../../../translations/en.json';
import { TurnFallbackRows } from './fallback-row';
import { turnServedModel, type TurnServedModel } from './served-model';

function render(working: boolean, events: TurnServedModel['fallbacks']): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
      <TurnFallbackRows working={working} events={events} />
    </NextIntlClientProvider>,
  );
}
const event = { requested: 'Sol', served: 'Flash', reason: 'rate_limit_exceeded' };

describe('TurnFallbackRows', () => {
  test('only settled requests show the safe error code and the actual switch', () => {
    expect(render(true, [event])).toBe('');
    const html = render(false, [event]);
    expect(html).toContain('Sol failed (rate limited) — switched to Flash.');
    expect(html).toContain('role="note"');
    expect(html).not.toContain('did not answer this turn');
  });

  test('no request events means no row, including legacy aggregate fallbacks', () => {
    expect(render(false, [])).toBe('');
    const usage: SessionModelUsage = { latest: null, billed_cost: 0, turns: {
      prompt: { served_models: ['Flash'], fallback_from: 'Sol', billed_cost: 0 },
    } };
    expect(render(false, turnServedModel(usage, 'prompt', undefined)!.fallbacks)).toBe('');
  });

  test('mixed direct and fallback requests name the event target, not the most-used model', () => {
    const usage: SessionModelUsage = { latest: null, billed_cost: 0, turns: {
      prompt: { served_models: ['sol', 'flash'], fallback_from: 'sol', billed_cost: 0,
        fallbacks: [{ requested_model: 'sol', served_model: 'flash', error_code: 'provider_unavailable' }] },
    } };
    const models = [
      { providerID: 'kortix', modelID: 'sol', modelName: 'Sol' },
      { providerID: 'kortix', modelID: 'flash', modelName: 'Flash' },
    ];
    const html = render(false, turnServedModel(usage, 'prompt', models)!.fallbacks);
    expect(html).toContain('Sol failed (error) — switched to Flash.');
    expect(html.match(/data-testid="turn-fallback-row"/g)).toHaveLength(1);
  });

  test('each request event retains its own source, reason and served model in order', () => {
    const html = render(false, [event, { requested: 'Flash', served: 'Other', reason: 'timeout' }, event]);
    expect(html.match(/data-testid="turn-fallback-row"/g)).toHaveLength(3);
    expect(html).toContain('Flash failed (error) — switched to Other.');
    expect(html.indexOf('switched to Flash.')).toBeLessThan(html.indexOf('switched to Other.'));
  });

  test('consecutive identical switches are one row with the request count', () => {
    const other = { requested: 'Flash', served: 'Other', reason: 'timeout' };
    const html = render(false, [...Array(1219).fill(event), other, event, event]);
    expect(html.match(/data-testid="turn-fallback-row"/g)).toHaveLength(3);
    expect(html).toContain('Sol failed (rate limited) on 1,219 requests — switched to Flash.');
    expect(html).toContain('Flash failed (error) — switched to Other.');
    expect(html).toContain('Sol failed (rate limited) on 2 requests — switched to Flash.');
    expect(html.indexOf('1,219')).toBeLessThan(html.indexOf('switched to Other.'));
  });
});
