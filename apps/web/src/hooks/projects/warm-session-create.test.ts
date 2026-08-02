import { describe, expect, test } from 'bun:test';
import {
  buildWarmSessionClaimInput,
  resolveWarmSessionForSend,
  shouldFallbackFromWarmClaim,
} from './warm-session-create';

describe('warm project session send', () => {
  test('claims the ensured session with selected immutable configuration', () => {
    expect(
      buildWarmSessionClaimInput(
        { session_id: 'session-1' },
        {
          agent_name: 'reviewer',
          sandbox_slug: 'large',
          pending_prompt: {
            text: 'Map this parcel.',
            attachment_names: ['parcel.geojson'],
          },
        },
      ),
    ).toEqual({
      session_id: 'session-1',
      agent_name: 'reviewer',
      sandbox_slug: 'large',
      pending_prompt: {
        text: 'Map this parcel.',
        attachment_names: ['parcel.geojson'],
      },
    });
  });

  test('falls back to normal creation when the warm session cannot be claimed', () => {
    expect(
      shouldFallbackFromWarmClaim({
        code: 'WARM_SESSION_CONFIGURATION_MISMATCH',
      }),
    ).toBe(true);
    expect(
      shouldFallbackFromWarmClaim({ code: 'WARM_SESSION_ALREADY_CLAIMED' }),
    ).toBe(true);
    expect(shouldFallbackFromWarmClaim({ code: 'PAYMENT_REQUIRED' })).toBe(false);
  });

  test('waits for the in-flight ensure before choosing normal creation', async () => {
    let resolved = false;
    const session = await resolveWarmSessionForSend(undefined, async () => {
      resolved = true;
      return { session_id: 'session-warm' };
    });

    expect(resolved).toBe(true);
    expect(session).toEqual({ session_id: 'session-warm' });
  });
});
