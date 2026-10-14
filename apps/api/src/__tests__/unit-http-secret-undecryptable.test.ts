/**
 * A request that reads a stored value this server cannot decrypt answers 409
 * with the message that names the value, never a generic 500, and sends no
 * Sentry event (KRTX-1719). Session create with a `secrets` allowlist, the
 * session-scope decide route and the network boundary all read project
 * secrets inside a request; the OAuth2 application routes read the encrypted
 * application config.
 */
import { describe, expect, mock, test } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';

const captured: unknown[] = [];
mock.module('../lib/sentry', () => ({
  captureException: (error: unknown) => captured.push(error),
  isSentryIgnoredError: () => false,
}));

const { installHttpErrors } = await import('../http-errors');
const { SecretUndecryptableError } = await import('../secrets/undecryptable');

function app(): OpenAPIHono {
  const server = new OpenAPIHono();
  installHttpErrors(server);
  server.post('/v1/projects/:projectId/sessions', () => {
    throw new SecretUndecryptableError('Project secret OPENAI_API_KEY');
  });
  server.get('/v1/plain', () => {
    throw new Error('boom');
  });
  return server;
}

describe('SecretUndecryptableError at the HTTP error handler', () => {
  test('answers 409 SECRET_UNDECRYPTABLE with the message naming the value, no Sentry event', async () => {
    captured.length = 0;
    const res = await app().request('/v1/projects/p-1/sessions', { method: 'POST' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "Project secret OPENAI_API_KEY cannot be decrypted with this server's encryption key. Re-enter its value.",
      code: 'SECRET_UNDECRYPTABLE',
    });
    expect(captured).toHaveLength(0);
  });

  test('any other error still answers the generic 500 and is captured', async () => {
    captured.length = 0;
    const res = await app().request('/v1/plain');
    expect(res.status).toBe(500);
    expect(captured).toHaveLength(1);
  });
});
