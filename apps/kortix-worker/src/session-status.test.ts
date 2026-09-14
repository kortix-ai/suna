import { describe, expect, test } from 'bun:test';
import { ChatEventAdapter } from './chat-events.ts';

describe('session.status vocabulary', () => {
  test('agent_start reports the canonical busy state', () => {
    const adapter = new ChatEventAdapter({ sessionID: 'ses-pi' });
    const status = adapter
      .translate({ type: 'agent_start' })
      .find((wire) => wire.type === 'session.status');

    expect(status?.properties.status).toEqual({ type: 'busy' });
  });

  test('agent_end reports the canonical idle state', () => {
    const adapter = new ChatEventAdapter({ sessionID: 'ses-pi' });
    const status = adapter
      .translate({ type: 'agent_end' })
      .find((wire) => wire.type === 'session.status');

    expect(status?.properties.status).toEqual({ type: 'idle' });
  });
});
