import { expect, mock, spyOn, test } from 'bun:test';

const endSession = mock(async () => ({ error: null }));
mock.module('@/lib/supabase/client', () => ({ createClient: () => ({ auth: { signOut: endSession } }) }));
mock.module('@/lib/utils/reset-client-state', () => ({ resetClientState: async () => {} }));
mock.module('@kortix/ui/internal/notifications/web-push', () => ({ stopWebPush: async () => {} }));

const { performSignOut } = await import('./perform-sign-out');

test('the shared sign-out posts to the stable endpoint before ending the session and leaving', async () => {
  const calls: string[] = [];
  const request = spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
  const errors = spyOn(console, 'error').mockImplementation(() => {});
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { assign: (url: string) => calls.push(url) } } });
  try {
    await performSignOut();
    expect(request.mock.calls[0]?.[0]).toBe('/api/auth/sign-out');
    expect(request.mock.calls[0]?.[1]?.method).toBe('POST');
    expect(calls).toEqual(['/auth']);
    expect(endSession).toHaveBeenCalledTimes(1);
    expect(errors).not.toHaveBeenCalled();
  } finally {
    request.mockRestore();
    errors.mockRestore();
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});
