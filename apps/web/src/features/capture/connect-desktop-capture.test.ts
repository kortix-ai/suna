import { describe, expect, test } from 'bun:test';

import { connectDesktopCapture, type ConnectDesktopCaptureDeps } from './connect-desktop-capture';

const PROJECT = '3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b';

function deps(over: Partial<ConnectDesktopCaptureDeps> = {}) {
  const calls: string[] = [];
  const d: ConnectDesktopCaptureDeps = {
    start: async () => {
      calls.push('start');
      return {
        ok: true,
        userCode: 'ABCD-1234',
        verificationUrl: 'https://kortix.test/capture/authorize?user_code=ABCD-1234',
      };
    },
    approve: async (code, project) => {
      calls.push(`approve ${code} ${project}`);
    },
    finish: async () => {
      calls.push('finish');
      return { ok: true };
    },
    cancel: async () => {
      calls.push('cancel');
    },
    openApproval: (url) => {
      calls.push(`open ${url}`);
    },
    ...over,
  };
  return { d, calls };
}

describe('connectDesktopCapture', () => {
  test('start → approve the code in place with the chosen project → finish; no browser', async () => {
    const { d, calls } = deps();
    expect(await connectDesktopCapture(PROJECT, d)).toEqual({ ok: true });
    expect(calls).toEqual(['start', `approve ABCD-1234 ${PROJECT}`, 'finish']);
  });

  test('an in-place approval that fails opens the approval page and keeps waiting', async () => {
    const { d, calls } = deps({
      approve: async () => {
        throw new Error('Only a person can approve a capture device');
      },
    });
    expect(await connectDesktopCapture(PROJECT, d)).toEqual({ ok: true });
    expect(calls).toEqual([
      'start',
      'open https://kortix.test/capture/authorize?user_code=ABCD-1234',
      'finish',
    ]);
  });

  test('a failed approval with no page to open cancels the sign-in and reports why', async () => {
    const { d, calls } = deps({
      start: async () => ({ ok: true, userCode: 'ABCD-1234' }),
      approve: async () => {
        throw new Error('feature_disabled');
      },
    });
    expect(await connectDesktopCapture(PROJECT, d)).toEqual({
      ok: false,
      error: 'feature_disabled',
    });
    expect(calls).toEqual(['cancel']);
  });

  test('a sign-in that never starts (no engine, no issuer) returns its error and approves nothing', async () => {
    const { d, calls } = deps({ start: async () => ({ ok: false, error: 'no Kortix URL' }) });
    expect(await connectDesktopCapture(PROJECT, d)).toEqual({ ok: false, error: 'no Kortix URL' });
    expect(calls).toEqual([]);
  });

  test('outside the desktop app: not available', async () => {
    const { d } = deps({ start: async () => null });
    expect((await connectDesktopCapture(PROJECT, d)).ok).toBe(false);
  });

  test('the engine refusing the token (denied, expired) comes back from finish', async () => {
    const { d } = deps({ finish: async () => ({ ok: false, error: 'the sign-in was denied' }) });
    expect(await connectDesktopCapture(PROJECT, d)).toEqual({
      ok: false,
      error: 'the sign-in was denied',
    });
  });
});
