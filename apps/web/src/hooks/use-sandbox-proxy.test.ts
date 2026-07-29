import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The preview-link bug was never in the URL builder's arithmetic — it was in
 * *when* the sandbox id was read. Both of these files captured the active
 * runtime once, at mount, and a mount happens before the runtime binds. These
 * are structural assertions: they fail if either file goes back to freezing it.
 */

const hookSource = readFileSync(
  fileURLToPath(new URL('./use-sandbox-proxy.ts', import.meta.url)),
  'utf8',
);

const interceptorSource = readFileSync(
  fileURLToPath(new URL('../components/localhost-link-interceptor.tsx', import.meta.url)),
  'utf8',
);

describe('useSandboxProxy', () => {
  test('derives the context reactively, never memoized on mount', () => {
    // `useMemo(() => createSandboxProxyContext(), [])` is the exact line that
    // froze `sandboxId: ''` and emitted `/v1/p//3000/` links for the life of
    // the page.
    expect(hookSource).not.toContain('createSandboxProxyContext(), []');
    expect(hookSource).toContain('useActiveSandboxProxyContext()');
  });

  test('exposes readiness so iframe callers can hold off', () => {
    expect(hookSource).toContain('isReady: context.isReady');
  });
});

describe('LocalhostLinkInterceptor', () => {
  test('resolves the proxy context inside the click handler, not in the effect closure', () => {
    const handlerStart = interceptorSource.indexOf('function handleClick');
    const listenerStart = interceptorSource.indexOf("document.addEventListener('click'");
    const resolveCall = interceptorSource.indexOf('resolveSandboxProxy()');

    expect(handlerStart).toBeGreaterThan(-1);
    expect(resolveCall).toBeGreaterThan(handlerStart);
    expect(resolveCall).toBeLessThan(listenerStart);
  });

  test('does not subscribe to the proxy hook at all — it mounts before any session exists', () => {
    // A hook here binds the context at app-root mount time, which is strictly
    // earlier than "a session runtime exists". There is nothing to subscribe to
    // that would be correct. (Prose mentions of the hook are fine — this is
    // about calling it and importing it.)
    expect(interceptorSource).not.toContain('useSandboxProxy(');
    expect(interceptorSource).not.toContain("from '@/hooks/use-sandbox-proxy'");
  });

  test('the click listener effect has no proxy-context dependencies to go stale', () => {
    const effectTail = interceptorSource.slice(
      interceptorSource.indexOf("document.addEventListener('click'"),
    );
    expect(effectTail).toContain('}, []);');
  });
});
