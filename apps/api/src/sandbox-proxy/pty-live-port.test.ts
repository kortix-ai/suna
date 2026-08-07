/**
 * The opencode PTY must follow opencode, not a constant.
 *
 * opencode's port MOVES: a verified config reload boots the replacement on the
 * idle half of the port pair and promotes it. `ws-proxy` hardcoded 4096, so
 * after one reload a terminal would open a WebSocket to a dead socket — and
 * only for sessions that had reloaded, which is the hardest kind of bug to
 * catch by hand.
 *
 * It was the last of five places that decided "is this opencode?" from a port
 * number; the other four are covered by `shared/opencode-ports`. This one could
 * not be, because the API cannot know which half is live without asking the box.
 */
import { describe, expect, test } from 'bun:test';
import { OPENCODE_PRIMARY_PORT, OPENCODE_STANDBY_PORT, isOpencodePort } from '../shared/opencode-ports';

const SRC = await Bun.file(new URL('./ws-proxy.ts', import.meta.url).pathname).text();
const HEALTH = await Bun.file(
  new URL('../../../kortix-sandbox-agent-server/src/routes/health.ts', import.meta.url).pathname,
).text();

function code(): string {
  return SRC.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');
}

describe('the PTY asks where opencode is', () => {
  test('resolves the port instead of hardcoding it', () => {
    const src = code();
    expect(src).toContain('resolveLiveOpencodePort(sandboxId)');
    // The regression shape: the ternary pinned to a constant.
    expect(src).not.toMatch(/ptyKind === 'opencode' \? OPENCODE_\w+_PORT : port/);
  });

  test('reads the daemon health field the daemon actually publishes', () => {
    // Both sides of one contract, in two packages — the API is useless if the
    // daemon calls it something else.
    expect(code()).toContain('opencode_port');
    expect(HEALTH).toContain('opencode_port:');
  });

  test('only accepts a port from the known pair', () => {
    // The value arrives in a response body. Following it blindly would let that
    // body aim the PTY at any port inside the sandbox.
    expect(code()).toContain('isOpencodePort(port)');
    expect(isOpencodePort(OPENCODE_PRIMARY_PORT)).toBe(true);
    expect(isOpencodePort(OPENCODE_STANDBY_PORT)).toBe(true);
    expect(isOpencodePort(3000)).toBe(false);
    expect(isOpencodePort(8000)).toBe(false);
  });

  test('falls back to 4096 rather than failing the connect', () => {
    // An older daemon does not report the field. Refusing the PTY there would
    // break terminals that work today, to fix a case that cannot arise on that
    // daemon — it never moves opencode's port.
    const src = code();
    expect(src).toContain('OPENCODE_FALLBACK_PORT');
    expect(src).toMatch(/catch \{\s*return OPENCODE_FALLBACK_PORT/);
  });

  test('the lookup is bounded, so a wedged box cannot hang the terminal', () => {
    expect(code()).toContain('AbortSignal.timeout(');
  });

  test('is NOT cached', () => {
    // The value changes on exactly the event this exists for. A cache would be
    // stale precisely when it matters.
    const fn = code().slice(code().indexOf('async function resolveLiveOpencodePort'));
    expect(fn).not.toContain('cache');
  });

  test('non-opencode PTYs still use the port the client addressed', () => {
    expect(code()).toContain(": port;");
  });
});
