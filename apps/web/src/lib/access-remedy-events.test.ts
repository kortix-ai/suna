/**
 * KRTX-2729 move-response-error-remedy-dispatch: the SDK core reports coded
 * 403 access remedies through the semantic `onAccessRemedy` sink; the HOST
 * owns the DOM. This pins web's half of the seam — `dispatchAccessRemedyEvent`
 * translates the remedy codes to exactly the CustomEvent names the
 * `MfaStepUpProvider` / `SsoRequiredProvider` listeners (layout.tsx) speak,
 * and stays silent where there is no window (SSR).
 */
import { describe, expect, test } from 'bun:test';
import { MFA_REQUIRED_EVENT } from '@/features/auth/mfa-step-up';
import { SSO_REQUIRED_EVENT } from '@/features/auth/sso-required';
import { dispatchAccessRemedyEvent } from './access-remedy-events';

function stubWindow() {
  const dispatched: string[] = [];
  const g = globalThis as { window?: unknown };
  const original = g.window;
  g.window = {
    dispatchEvent: (e: { type: string }) => {
      dispatched.push(e.type);
      return true;
    },
  };
  return {
    dispatched,
    restore: () => {
      if (original === undefined) delete g.window;
      else g.window = original;
    },
  };
}

describe('dispatchAccessRemedyEvent · the host side of the remedy seam', () => {
  test("an account_mfa_required remedy dispatches exactly the listeners' MFA event name", () => {
    const win = stubWindow();
    try {
      dispatchAccessRemedyEvent('account_mfa_required');
      expect(win.dispatched).toEqual([MFA_REQUIRED_EVENT]);
    } finally {
      win.restore();
    }
  });

  test("an sso_required remedy dispatches exactly the listeners' SSO event name", () => {
    const win = stubWindow();
    try {
      dispatchAccessRemedyEvent('sso_required');
      expect(win.dispatched).toEqual([SSO_REQUIRED_EVENT]);
    } finally {
      win.restore();
    }
  });

  test('without a window (SSR) it is a silent no-op', () => {
    const g = globalThis as { window?: unknown };
    const original = g.window;
    delete g.window;
    try {
      expect(() => dispatchAccessRemedyEvent('account_mfa_required')).not.toThrow();
    } finally {
      if (original === undefined) delete g.window;
      else g.window = original;
    }
  });
});
