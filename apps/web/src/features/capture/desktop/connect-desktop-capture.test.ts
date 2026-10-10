import { describe, expect, test } from 'bun:test';

import { connectDesktopCapture, type ConnectDesktopCaptureDeps } from './connect-desktop-capture';

const ACCOUNT = '3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b';

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
    approve: async (code, account) => {
      calls.push(`approve ${code} ${account}`);
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
  test('start → approve the code in place with the chosen account → finish; no browser', async () => {
    const { d, calls } = deps();
    expect(await connectDesktopCapture(ACCOUNT, d)).toEqual({ ok: true });
    expect(calls).toEqual(['start', `approve ABCD-1234 ${ACCOUNT}`, 'finish']);
  });

  test('an in-place approval that fails opens the approval page and keeps waiting', async () => {
    const { d, calls } = deps({
      approve: async () => {
        throw new Error('Only a person can approve a capture device');
      },
    });
    expect(await connectDesktopCapture(ACCOUNT, d)).toEqual({ ok: true });
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
    expect(await connectDesktopCapture(ACCOUNT, d)).toEqual({
      ok: false,
      error: 'feature_disabled',
    });
    expect(calls).toEqual(['cancel']);
  });

  test('a sign-in that never starts (no engine, no issuer) returns its error and approves nothing', async () => {
    const { d, calls } = deps({ start: async () => ({ ok: false, error: 'no Kortix URL' }) });
    expect(await connectDesktopCapture(ACCOUNT, d)).toEqual({ ok: false, error: 'no Kortix URL' });
    expect(calls).toEqual([]);
  });

  test('outside the desktop app: not available', async () => {
    const { d } = deps({ start: async () => null });
    expect((await connectDesktopCapture(ACCOUNT, d)).ok).toBe(false);
  });

  test('the engine refusing the token (denied, expired) comes back from finish', async () => {
    const { d } = deps({ finish: async () => ({ ok: false, error: 'the sign-in was denied' }) });
    expect(await connectDesktopCapture(ACCOUNT, d)).toEqual({
      ok: false,
      error: 'the sign-in was denied',
    });
  });
});

describe('turning on Capture never touches the computer agent (tunnel)', () => {
  test('with an unpaired computer: only capture_* bridge commands and /capture/ API requests', async () => {
    const { approveCaptureDeviceGrant, createKortix } = await import('@kortix/sdk');
    const requests: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requests.push(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      );
      return Response.json({ user_code: 'ABCD-1234', status: 'approved', account_id: ACCOUNT });
    }) as typeof fetch;
    const bridge: string[] = [];
    try {
      createKortix({ backendUrl: 'http://api.test/v1', getToken: async () => 'tok' });
      const result = await connectDesktopCapture(ACCOUNT, {
        start: async () => (
          bridge.push('capture_sign_in_start'),
          {
            ok: true,
            userCode: 'ABCD-1234',
            verificationUrl: 'http://app.test/capture/authorize?user_code=ABCD-1234',
          }
        ),
        approve: (code, account) => approveCaptureDeviceGrant(code, account),
        finish: async () => (bridge.push('capture_sign_in_finish'), { ok: true }),
        cancel: async () => bridge.push('capture_sign_in_cancel'),
        openApproval: () => bridge.push('open-approval-page'),
      });
      expect(result.ok).toBe(true);
    } finally {
      globalThis.fetch = original;
    }
    expect(bridge).toEqual(['capture_sign_in_start', 'capture_sign_in_finish']);
    expect(requests).toEqual(['http://api.test/v1/capture/device/grants/ABCD-1234/approve']);
    expect(requests.some((url) => url.includes('/tunnel'))).toBe(false);
  });
});
