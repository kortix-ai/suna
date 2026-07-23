import { describe, expect, test } from 'bun:test';

import { ApiError } from '../api/client.ts';
import { surfaceApiError, surfaceSessionCreateError } from '../command-helpers.ts';

// `POST /projects/:id/sessions` 409s with `code: 'COMPOSER_CAPABILITY_BLOCKED'`
// and a structured `capabilities` object (apps/api/src/projects/lib/
// sessions.ts, the `!composerCapability.can_start` branch) — not just a
// rendered string. `sessions new` used to fall through to the generic
// `surfaceApiError` printer for this, showing only `HTTP 409: <message>`
// with no follow-up action. See docs/specs/2026-07-21-cli-credential-model-
// ux.md §1.6/§3.5/Open Questions §4.

function capture(fn: () => number): { code: number; out: string } {
  const chunks: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  (process.stderr.write as unknown) = (s: string) => {
    chunks.push(s);
    return true;
  };
  let code: number;
  try {
    code = fn();
  } finally {
    process.stderr.write = orig;
  }
  return { code, out: chunks.join('') };
}

describe('surfaceSessionCreateError', () => {
  test('renders harness, reason, and compatible connections from the structured body', () => {
    const err = new ApiError(409, 'Pi has no compatible credential connected.', {
      error: 'Pi has no compatible credential connected.',
      code: 'COMPOSER_CAPABILITY_BLOCKED',
      capabilities: {
        agent: { name: 'pi', harness: 'pi', native_agent: null, enabled: true },
        auth: {
          compatible: ['managed_gateway', 'anthropic_api_key', 'openai_api_key'],
          active: null,
          ready: false,
          reason: null,
        },
        model: {
          policy: 'gateway-catalog',
          default_allowed: false,
          custom_allowed: false,
          live_change: false,
          presets: [],
        },
        can_start: false,
        blocking_reason: 'Pi has no compatible credential connected.',
      },
    });

    const { code, out } = capture(() => surfaceSessionCreateError(err));

    expect(code).toBe(1);
    expect(out).toContain('pi');
    expect(out).toContain('Pi has no compatible credential connected.');
    expect(out).toContain('managed_gateway');
    expect(out).toContain('anthropic_api_key');
    expect(out).toContain('kortix providers ls');
    expect(out).not.toContain('HTTP 409');
  });

  test('falls back to surfaceApiError for a 409 without the composer-blocked code', () => {
    const err = new ApiError(409, 'some other conflict', { error: 'some other conflict' });
    const { code: expectedCode, out: expectedOut } = capture(() => surfaceApiError(err));
    const { code, out } = capture(() => surfaceSessionCreateError(err));
    expect(code).toBe(expectedCode);
    expect(out).toBe(expectedOut);
  });

  test('falls back to surfaceApiError for a non-409 error', () => {
    const err = new ApiError(500, 'boom', { error: 'boom' });
    const { code, out } = capture(() => surfaceSessionCreateError(err));
    expect(code).toBe(1);
    expect(out).toContain('HTTP 500');
  });
});
