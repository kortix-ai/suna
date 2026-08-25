import { expect, test } from 'bun:test';
import type { SessionConnectRequest } from '@kortix/sdk';
import { sessionConnectPrompt } from './session-connect-requests';

const request = (over: Partial<SessionConnectRequest> = {}): SessionConnectRequest => ({
  slug: 'gmail',
  app: 'Gmail',
  provider: 'composio',
  connected: false,
  ...over,
});

test('nothing to show when the API returned no requests', () => {
  expect(sessionConnectPrompt(undefined).pending).toEqual([]);
  expect(sessionConnectPrompt([]).pending).toEqual([]);
});

test('a connector connected since the agent asked stops rendering', () => {
  expect(sessionConnectPrompt([request({ connected: true })]).pending).toEqual([]);
});

test('one pending connector names itself', () => {
  const prompt = sessionConnectPrompt([request()]);
  expect(prompt.pending).toHaveLength(1);
  expect(prompt.label).toBe('Gmail');
});

test('a retried connect call does not produce two buttons for one account', () => {
  expect(sessionConnectPrompt([request(), request()]).pending).toHaveLength(1);
});

test('several pending connectors read as a sentence', () => {
  const prompt = sessionConnectPrompt([
    request(),
    request({ slug: 'slack', app: 'Slack', provider: 'pipedream' }),
    request({ slug: 'notion', app: 'Notion' }),
  ]);
  expect(prompt.label).toBe('Gmail, Slack and Notion');
});

test('falls back to the slug when the provider gave no app label', () => {
  expect(sessionConnectPrompt([request({ app: '' })]).label).toBe('gmail');
});
