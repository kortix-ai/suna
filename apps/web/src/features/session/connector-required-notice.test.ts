import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { doscoSendErrorConnector } from '@kortix/sdk/react';

import { connectorNoticeCopy } from './connector-required-notice';

const connector = (
  name: string,
  authorization_strategy: 'project' | 'user',
): doscoSendErrorConnector => ({
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

/**
 * The card shipped correct and rendered nothing for weeks.
 *
 * It was mounted with `error={sessionState?.sendError}`. The SDK sets
 * `sendError` only inside `useSession.send()`; this app has always sent through
 * `sendParts`, so that value is permanently null. And `TurnErrorDisplay`
 * deliberately `return null`s for `kind: 'connector'` to leave the remedy to
 * this card — so a refused turn produced NO card and NO pill. The server
 * refused correctly, the SDK classified correctly, and the user saw silence.
 *
 * Every unit test here passed throughout, because they all test the pure copy
 * helper. These two assert the wiring instead. They read the source rather than
 * render it: `session-chat.tsx` is ~3700 lines with a deep provider tree, and a
 * test that cannot be written without a full harness is a test nobody adds.
 */
const SESSION_CHAT = readFileSync(join(import.meta.dir, 'session-chat.tsx'), 'utf8');

describe('ConnectorRequiredNotice is wired to a value that is actually set', () => {
  test('it is fed commandError, never the always-null sendError', () => {
    const mount = SESSION_CHAT.split('<ConnectorRequiredNotice')[1]?.split('/>')[0];
    expect(mount).toBeTruthy();
    expect(mount).toContain('error={commandError}');
    expect(mount).not.toContain('sendError');
  });

  test('commandError is populated on a send failure', () => {
    // The other half of the invariant: feeding the card a state nobody writes
    // would fail exactly the same way, silently.
    expect(SESSION_CHAT).toContain('setCommandError(result.error)');
  });
});
