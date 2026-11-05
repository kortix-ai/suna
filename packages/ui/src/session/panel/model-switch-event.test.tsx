import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ModelSwitchEvent } from './model-switch-event';

test('model switch timeline names both models, author and continuation', () => {
  const html = renderToStaticMarkup(<ModelSwitchEvent summary={{ from: 'old/model', to: 'new/model', actor_session_id: 'self', prompt: 'Finish the task' }} />);
  for (const text of ['old/model', 'new/model', 'self', 'Finish the task']) expect(html).toContain(text);
});
test('unrelated or malformed events do not claim a model switch', () => {
  expect(renderToStaticMarkup(<ModelSwitchEvent summary={null} />)).toBe('');
  expect(renderToStaticMarkup(<ModelSwitchEvent summary={{ to: 42 }} />)).toBe('');
});

test('persisted history renders for an ordinary viewer without audit access', async () => {
  const { ModelSwitchHistory } = await import('./model-switch-event');
  const html = renderToStaticMarkup(<ModelSwitchHistory history={[{ id: 'switch-1', from: 'old', to: 'new', prompt: 'Continue', actor_session_id: 'caller', at: '2026-11-04T00:00:00Z' }]} />);
  expect(html).toContain('Model switches');
  expect(html).toContain('Continue');
  expect(html).toContain('2026-11-04T00:00:00Z');
});
