import { describe, expect, test } from 'bun:test';
import { redactSentryRequestSecrets, redactUrlSecrets } from './redact-url-secrets';

const TICKET = 'Zm9vYmFyYmF6cXV4c2VjcmV0dGlja2V0dmFsdWU';
const LIVE = `/v1/projects/p/artifacts/a/live?ticket=${TICKET}`;

describe('URL secret redaction', () => {
  test('a ticket query value becomes <redacted>; the rest of the URL stays', () => {
    expect(redactUrlSecrets(`https://api.example.test${LIVE}&view=page`))
      .toBe('https://api.example.test/v1/projects/p/artifacts/a/live?ticket=<redacted>&view=page');
    expect(redactUrlSecrets(LIVE)).toBe('/v1/projects/p/artifacts/a/live?ticket=<redacted>');
    expect(redactUrlSecrets('/v1/projects/p/artifacts?status=open')).toBe('/v1/projects/p/artifacts?status=open');
  });

  test('other credential query values are redacted too: preview ?token=, access_token, refresh_token, public_share', () => {
    expect(redactUrlSecrets('/v1/p/sbx/8000/pty/ws?token=kortix_pat_secret&cols=80'))
      .toBe('/v1/p/sbx/8000/pty/ws?token=<redacted>&cols=80');
    expect(redactUrlSecrets('/x?a=1&access_token=eyJsecret&refresh_token=r1&public_share=s1'))
      .toBe('/x?a=1&access_token=<redacted>&refresh_token=<redacted>&public_share=<redacted>');
    // A parameter that only contains the word stays: `tokens=3` is not a credential.
    expect(redactUrlSecrets('/x?tokens=3&max_token_count=9')).toBe('/x?tokens=3&max_token_count=9');
    expect(JSON.stringify(redactSentryRequestSecrets({ request: { query_string: { token: 'kortix_pat_secret' } } }))).not.toContain('kortix_pat_secret');
  });

  test('a Sentry event of a /live?ticket= request carries no ticket value', () => {
    const event = {
      transaction: `GET ${LIVE}`,
      request: { url: `https://api.example.test${LIVE}`, query_string: `ticket=${TICKET}` },
    };
    expect(JSON.stringify(redactSentryRequestSecrets(event))).not.toContain(TICKET);
    for (const query_string of [{ ticket: TICKET }, [['ticket', TICKET]]]) {
      expect(JSON.stringify(redactSentryRequestSecrets({ request: { url: LIVE, query_string } }))).not.toContain(TICKET);
    }
  });
});
