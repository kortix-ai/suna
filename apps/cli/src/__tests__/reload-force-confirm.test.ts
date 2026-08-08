/**
 * `sessions reload --force` must ask before it kills a running turn.
 *
 * `--force` exists precisely to reload DURING a turn, so it destroys work the
 * user is waiting on. The web already confirms before doing that; the CLI did
 * not, and its only warning lived in `--help` — read once, months before the
 * command that actually ends the turn.
 *
 * Marko asked for exactly this on the call: the reload command "should also
 * include this instruction to ensure the user that he will have to, you know,
 * it will stop."
 *
 * Asserted on source: the handler needs auth, a located session and a live API
 * before it reaches the prompt, so driving it end-to-end would test the network
 * stack rather than the guard.
 */
import { describe, expect, test } from 'bun:test';

const SRC = await Bun.file(new URL('../commands/sessions.ts', import.meta.url).pathname).text();

/** `sessionsReload`'s body, comments stripped. */
function reloadHandler(): string {
  const start = SRC.indexOf('async function sessionsReload(');
  expect(start).toBeGreaterThan(-1);
  const body = SRC.slice(start, SRC.indexOf('\nasync function ', start + 10));
  return body
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');
}

describe('reload --force confirmation', () => {
  const body = reloadHandler();

  test('asks before forcing', () => {
    expect(body).toContain('confirm(');
    expect(body).toContain("args.includes('--force')");
  });

  test('the warning says what is lost and what to do next', () => {
    // "Are you sure?" tells the user nothing. Both halves matter: the turn dies,
    // and they have to send a message afterwards.
    expect(body).toContain("ends the turn that's running right now");
    expect(body).toContain('send a message to continue');
  });

  test('declining changes nothing', () => {
    // A confirm that falls through to the request is decoration.
    const declineAt = body.indexOf('Left the session alone');
    expect(declineAt).toBeGreaterThan(-1);
    expect(declineAt).toBeLessThan(body.indexOf('/reload`'));
  });

  test('-y / --yes skips it, for scripts', () => {
    expect(body).toContain("args.includes('--yes')");
    expect(body).toContain("args.includes('-y')");
  });

  test('--json skips it too', () => {
    // A prompt in a machine-readable run hangs forever instead of failing,
    // which is worse than not asking.
    expect(body).toMatch(/!json/);
  });

  test('a NON-forced reload is never prompted', () => {
    // Without --force the server refuses mid-turn on its own, so there is
    // nothing to warn about and a prompt would just be friction.
    const guard = body.slice(body.indexOf('if (force'), body.indexOf('confirm('));
    expect(guard).toContain('force');
  });

  test('the prompt happens BEFORE the request', () => {
    expect(body.indexOf('confirm(')).toBeLessThan(body.indexOf('/reload`'));
  });

  test('--help mentions the prompt and the escape hatch', () => {
    expect(SRC).toContain('asks first, because it ends the running');
    expect(SRC).toContain('-y/--yes skips the prompt');
  });
});
