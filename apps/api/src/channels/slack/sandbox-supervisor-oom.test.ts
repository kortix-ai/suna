import { describe, expect, test } from 'bun:test';

// Source tripwire for the 2026-08-28 zombie-sandbox incident.
//
// The guest kernel OOM-killed `kortix-agent` and the supervisor loop EXITED
// instead of relaunching: exit 137 after 4472s matched neither the swap-code
// branch nor the early-exit branch, so it fell through to `exit "${status}"`.
// The comment there assumed that was safe because "this is PID 1 and the
// provider decides what a stopped sandbox means" — false on Platinum, where
// PID 1 is `/bin/sh /sbin/pt-init`. The script exiting does not stop the VM, so
// the box became a corpse: DB status='active', provider state='running', port
// 8000 closed forever, and nothing reconciled it.
//
// Observed on 2 of 21 active prod sandboxes; correlation was exact across the
// fleet: oom_kill <=> `agent exited 137` <=> port 8000 shut.

const entrypoint = (): Promise<string> =>
  Bun.file(new URL('../../../../sandbox/entrypoint.sh', import.meta.url)).text();

describe('sandbox supervisor survives an OOM kill', () => {
  test('a SIGKILL relaunches the daemon instead of exiting the supervisor', async () => {
    const source = await entrypoint();
    const guard = source.indexOf('if [ "${status}" -eq 137 ]');
    const fallthrough = source.indexOf('agent exited ${status} after ${ran}s; exiting');
    expect(guard).toBeGreaterThan(-1);
    // The relaunch must be decided BEFORE the unconditional exit, or it is dead code.
    expect(fallthrough).toBeGreaterThan(guard);
    expect(source.slice(guard, fallthrough)).toContain('continue');
  });

  test('the relaunch is bounded, and a healthy run earns a fresh budget', async () => {
    const source = await entrypoint();
    expect(source).toContain('MAX_SIGKILL_RELAUNCH');
    const guard = source.indexOf('if [ "${status}" -eq 137 ]');
    const block = source.slice(guard, guard + 700);
    expect(block).toContain('${ran}" -ge "${HEALTHY_AFTER_S}');
  });

  test('a deliberate stop still exits — only SIGKILL relaunches', async () => {
    const source = await entrypoint();
    // 143 (SIGTERM) and 130 (SIGINT) are the provider stopping the box. If the
    // loop relaunched on those it would fight a shutdown forever.
    expect(source).not.toContain('"${status}" -ge 128');
    expect(source).not.toContain('"${status}" -eq 143');
  });
});
