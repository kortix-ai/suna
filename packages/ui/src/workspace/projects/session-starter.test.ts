import { describe, expect, test } from 'bun:test';
import { sessionStarter } from './session-starter';

const labels = { you: 'You', unknown: 'Unknown' };
const base = { is_owner: true, owner_name: null, owner_email: null, created_by: 'u1' };

describe('sessionStarter', () => {
  test('a member initiator matching the viewer reads "You"', () => {
    const s = sessionStarter(
      { ...base, initiator: { type: 'member', id: 'u1', label: 'Ann' } },
      'u1',
      labels,
    );
    expect(s).toMatchObject({ type: 'member', isViewer: true, label: 'You' });
  });

  test('a member initiator that is another user shows their name', () => {
    const s = sessionStarter(
      { ...base, is_owner: false, initiator: { type: 'member', id: 'u2', label: 'Bo' } },
      'u1',
      labels,
    );
    expect(s).toMatchObject({ isViewer: false, label: 'Bo' });
  });

  test('a child the viewer created but an agent run started by someone else is not "You"', () => {
    // Children keep created_by (is_owner true) but show the run's starter.
    const s = sessionStarter(
      { ...base, is_owner: true, initiator: { type: 'member', id: 'u2', label: 'Bo' } },
      'u1',
      labels,
    );
    expect(s).toMatchObject({ isViewer: false, label: 'Bo' });
  });

  test('a trigger initiator is never the viewer and shows its slug', () => {
    const s = sessionStarter(
      { ...base, initiator: { type: 'trigger', id: 'nightly', label: 'nightly' } },
      'u1',
      labels,
    );
    expect(s).toMatchObject({ type: 'trigger', isViewer: false, label: 'nightly', id: 'nightly' });
  });

  test('channel, api and system keep their type and label', () => {
    expect(
      sessionStarter({ ...base, initiator: { type: 'channel', id: 'slack', label: 'Slack' } }, 'u1', labels),
    ).toMatchObject({ type: 'channel', label: 'Slack', id: 'slack' });
    expect(
      sessionStarter({ ...base, initiator: { type: 'api', id: 'sa1', label: 'CI' } }, 'u1', labels),
    ).toMatchObject({ type: 'api', label: 'CI' });
    expect(
      sessionStarter({ ...base, initiator: { type: 'system', id: 'system:x', label: 'Kortix' } }, 'u1', labels),
    ).toMatchObject({ type: 'system', label: 'Kortix' });
  });

  test('no initiator falls back to the creator via is_owner', () => {
    expect(sessionStarter({ ...base, initiator: null }, 'u1', labels)).toMatchObject({
      type: 'member',
      isViewer: true,
      label: 'You',
    });
    expect(
      sessionStarter({ ...base, is_owner: false, owner_name: 'Cy', initiator: null }, 'u1', labels),
    ).toMatchObject({ isViewer: false, label: 'Cy' });
  });
});
