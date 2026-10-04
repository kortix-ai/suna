/**
 * MCP 2026-07-28 authorization hardening. Three normative rules that the
 * 2025-06-18-era implementation predates:
 *
 *  - SEP-2468 / RFC 9207: a client MUST validate a present `iss` against the
 *    recorded issuer before redeeming the authorization code. This is the
 *    authorization-code-injection defence: without it, a code minted by a
 *    hostile authorization server can be redeemed against the honest one.
 *  - SEP-837: dynamic registration MUST state an `application_type`, or an
 *    OIDC-based server rejects loopback redirect URIs.
 *  - SEP-2352: credentials are bound to the issuer that minted them.
 */
import { describe, expect, test } from 'bun:test';
import { oauth2ApplicationTypeFor, validateAuthorizationIssuer } from './oauth2-issuer';

describe('validateAuthorizationIssuer (RFC 9207)', () => {
  test('accepts a callback whose iss matches the recorded issuer', () => {
    expect(
      validateAuthorizationIssuer({ received: 'https://authn.read.ai/', recorded: 'https://authn.read.ai/' }),
    ).toEqual({ ok: true });
  });

  test('rejects a callback from a different issuer', () => {
    expect(
      validateAuthorizationIssuer({ received: 'https://evil.example/', recorded: 'https://authn.read.ai/' }),
    ).toEqual({ ok: false, errorCode: 'issuer_mismatch' });
  });

  test('a trailing slash is not a mismatch', () => {
    expect(
      validateAuthorizationIssuer({ received: 'https://authn.read.ai', recorded: 'https://authn.read.ai/' }),
    ).toEqual({ ok: true });
    expect(
      validateAuthorizationIssuer({ received: 'https://authn.read.ai/', recorded: 'https://authn.read.ai' }),
    ).toEqual({ ok: true });
  });

  test('a host or scheme difference IS a mismatch, even when it looks close', () => {
    expect(
      validateAuthorizationIssuer({ received: 'http://authn.read.ai/', recorded: 'https://authn.read.ai/' }),
    ).toEqual({ ok: false, errorCode: 'issuer_mismatch' });
    expect(
      validateAuthorizationIssuer({ received: 'https://authn.read.ai.evil.test/', recorded: 'https://authn.read.ai/' }),
    ).toEqual({ ok: false, errorCode: 'issuer_mismatch' });
    // Path matters: an issuer is not just an origin.
    expect(
      validateAuthorizationIssuer({ received: 'https://login.example.com/tenant-b', recorded: 'https://login.example.com/tenant-a' }),
    ).toEqual({ ok: false, errorCode: 'issuer_mismatch' });
  });

  test('the spec validates a PRESENT iss; an absent one is not an error', () => {
    expect(validateAuthorizationIssuer({ received: undefined, recorded: 'https://authn.read.ai/' })).toEqual({ ok: true });
    expect(validateAuthorizationIssuer({ received: null, recorded: 'https://authn.read.ai/' })).toEqual({ ok: true });
  });

  test('an unparseable iss is rejected rather than ignored', () => {
    expect(
      validateAuthorizationIssuer({ received: 'not a url', recorded: 'https://authn.read.ai/' }),
    ).toEqual({ ok: false, errorCode: 'issuer_mismatch' });
  });

  test('when nothing was recorded there is nothing to compare against', () => {
    // Applications saved before the issuer was persisted must keep working.
    expect(validateAuthorizationIssuer({ received: 'https://authn.read.ai/', recorded: undefined })).toEqual({ ok: true });
  });
});

describe('oauth2ApplicationTypeFor (SEP-837)', () => {
  test('an https callback is a web client', () => {
    expect(oauth2ApplicationTypeFor('https://api.kortix.com/v1/connectors/oauth2/callback')).toBe('web');
  });

  test('a loopback callback is a native client — OIDC servers reject localhost for web', () => {
    expect(oauth2ApplicationTypeFor('http://localhost:8008/v1/connectors/oauth2/callback')).toBe('native');
    expect(oauth2ApplicationTypeFor('http://127.0.0.1:8008/v1/connectors/oauth2/callback')).toBe('native');
  });

  test('an unparseable redirect URI falls back to web', () => {
    expect(oauth2ApplicationTypeFor('not a url')).toBe('web');
  });
});
