/**
 * `apiErrorMessage` is the one place the sandbox channel CLIs (slack, teams)
 * turn a failed apps/api response into readable text. The API's structured
 * denial is `{ error: true, message, code, action }` (iam/denial-message.ts):
 * `error` is a boolean flag and the text is in `message`.
 */
import { describe, expect, test } from 'bun:test';
import { apiErrorMessage } from '../../../sandbox/slack-cli/lib/api';

const DENIAL =
  'This agent session is not granted "project.connector.read". Add it to the agent\'s kortix_permissions in kortix.yaml and merge the change.';

describe('apiErrorMessage', () => {
  test('a structured denial resolves to its message, not the boolean flag', () => {
    const body = JSON.stringify({
      error: true,
      message: DENIAL,
      code: 'agent_scope_insufficient',
      action: 'project.connector.read',
    });
    expect(apiErrorMessage(403, 'Forbidden', body)).toBe(DENIAL);
  });

  test('a string error field is the message when no message field exists', () => {
    expect(apiErrorMessage(404, 'Not Found', JSON.stringify({ error: 'plain' }))).toBe('plain');
  });

  test('message wins over a string error field', () => {
    const body = JSON.stringify({ error: 'short', message: 'long form' });
    expect(apiErrorMessage(400, 'Bad Request', body)).toBe('long form');
  });

  test('a non-JSON body is returned as raw text', () => {
    expect(apiErrorMessage(502, 'Bad Gateway', 'upstream timed out')).toBe('upstream timed out');
  });

  test('an empty body falls back to statusText, then to HTTP <status>', () => {
    expect(apiErrorMessage(403, 'Forbidden', '')).toBe('Forbidden');
    expect(apiErrorMessage(403, '', '')).toBe('HTTP 403');
  });

  test('{ error: true } without a message never resolves to the string "true"', () => {
    const body = JSON.stringify({ error: true });
    const message = apiErrorMessage(403, '', body);
    expect(message).not.toBe('true');
    // The raw body is kept: it is the only detail the server sent.
    expect(message).toBe(body);
  });

  test('an object-shaped error (validation body) keeps the raw body, not "[object Object]"', () => {
    const body = JSON.stringify({ success: false, error: { issues: [{ path: ['url'] }] } });
    expect(apiErrorMessage(400, 'Bad Request', body)).toBe(body);
  });
});
