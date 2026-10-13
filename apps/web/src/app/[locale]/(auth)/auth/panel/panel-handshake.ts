import { EXTENSION_ORIGIN } from '@/lib/supabase/panel-cookies';

import { NEED_SESSION_MESSAGE, readPanelSessionMessage } from './panel-message';

/** The slice of the Supabase auth client the handshake uses. */
interface PanelAuth {
  getSession(): Promise<{ data: { session: unknown } }>;
  signOut(options: { scope: 'local' }): Promise<unknown>;
  verifyOtp(params: { token_hash: string; type: 'magiclink' }): Promise<{ error: unknown }>;
}

interface PanelWindow {
  parent: { postMessage(message: unknown, targetOrigin: string): void };
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}

/**
 * Get this frame a session: keep the one it has, or ask the extension for a
 * one-time token and trade it. With `switchAccount` the frame's own session is
 * dropped first (scope `local`: only this frame's session, never the user's
 * tab), so the extension's account replaces it. Calls `finish(true)` once the
 * frame has a session, `finish(false)` on any failure. Returns the cleanup.
 */
export function startPanelHandshake(options: {
  auth: PanelAuth;
  win: PanelWindow;
  switchAccount: boolean;
  timeoutMs: number;
  finish: (ok: boolean) => void;
}): () => void {
  const { auth, win, switchAccount, timeoutMs, finish } = options;
  let redeemed = false;
  const onMessage = (event: MessageEvent) => {
    const tokenHash = readPanelSessionMessage(event, win.parent);
    // One redeem per frame: the token is single-use.
    if (!tokenHash || redeemed) return;
    redeemed = true;
    void auth
      .verifyOtp({ token_hash: tokenHash, type: 'magiclink' })
      .then(({ error }) => finish(!error))
      .catch(() => finish(false));
  };
  win.addEventListener('message', onMessage);
  const timer = setTimeout(() => finish(false), timeoutMs);

  void (async () => {
    if (switchAccount) await auth.signOut({ scope: 'local' });
    const { data } = await auth.getSession();
    if (data.session) finish(true);
    else win.parent.postMessage(NEED_SESSION_MESSAGE, EXTENSION_ORIGIN);
  })().catch(() => finish(false));

  return () => {
    win.removeEventListener('message', onMessage);
    clearTimeout(timer);
  };
}
