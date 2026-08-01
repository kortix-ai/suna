import { describe, expect, test } from 'bun:test';
import type { KortixSendErrorConnector } from '@kortix/sdk/react';

import { connectorNoticeCopy } from './connector-required-notice';

const connector = (
  name: string,
  authorization_strategy: 'project' | 'user',
): KortixSendErrorConnector => ({
  id: `id-${name}`,
  slug: name.toLowerCase(),
  name,
  authorization_strategy,
});

describe('connectorNoticeCopy', () => {
  test('names one connector plainly', () => {
    expect(connectorNoticeCopy([connector('Gmail', 'project')]).label).toBe('Gmail');
  });

  test('joins two with "and", and three with commas plus "and"', () => {
    // The label lands mid-sentence ("This session needs …"), so a bare
    // comma-joined list reads as a fragment.
    expect(
      connectorNoticeCopy([connector('Gmail', 'project'), connector('Slack', 'project')]).label,
    ).toBe('Gmail and Slack');
    expect(
      connectorNoticeCopy([
        connector('Gmail', 'project'),
        connector('Slack', 'project'),
        connector('Notion', 'project'),
      ]).label,
    ).toBe('Gmail, Slack and Notion');
  });

  test('a project-strategy connector is connectable from here', () => {
    // One shared connection serves the project, so anyone who can mint a setup
    // link fixes it once.
    expect(connectorNoticeCopy([connector('Gmail', 'project')]).connectable).toHaveLength(1);
  });

  test('a user-strategy connector is NOT — a button would only ever 409', () => {
    // That connection must belong to the account the session RUNS AS. Nobody
    // else can supply it, so the card owes the user a sentence, not a control
    // that fails when pressed.
    expect(connectorNoticeCopy([connector('Gmail', 'user')]).connectable).toEqual([]);
  });

  test('a mixed set still offers the button, for the ones it can serve', () => {
    const { connectable } = connectorNoticeCopy([
      connector('Gmail', 'user'),
      connector('Slack', 'project'),
    ]);
    expect(connectable.map((entry) => entry.name)).toEqual(['Slack']);
  });

  test('an empty set yields an empty label rather than the string "undefined"', () => {
    expect(connectorNoticeCopy([])).toEqual({ label: '', connectable: [] });
  });
});
