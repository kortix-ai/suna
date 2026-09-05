import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  PREVIEW_GUARD_CONTAINER,
  PREVIEW_GUARD_HEREDOC,
  PREVIEW_GUARD_SCRIPT,
  buildPreviewGuardInstall,
} from '../src/core/preview-guard';

describe('preview guard — the self-healer a branch environment runs on its own box', () => {
  it('is valid POSIX shell', () => {
    // busybox sh runs it on the sandbox; `sh -n` here is the closest local
    // parse. A heredoc typo would otherwise surface as a guard that never
    // starts, on a box nobody is watching.
    const parsed = spawnSync('sh', ['-n'], { input: PREVIEW_GUARD_SCRIPT, encoding: 'utf8' });
    expect(parsed.stderr).toBe('');
    expect(parsed.status).toBe(0);
  });

  it('never fights a deploy, and never touches the data volumes', () => {
    // A phase file with no exit file is a deploy in flight: the guard may
    // prune disk but must not restart anything under a running bootstrap.
    expect(PREVIEW_GUARD_SCRIPT).toContain('deploy_running() {');
    expect(PREVIEW_GUARD_SCRIPT).toContain('if deploy_running; then continue; fi');
    expect(PREVIEW_GUARD_SCRIPT).toContain('[ -f "$EXIT" ] && return 1');
    // `down` clears wreckage; `down -v` would delete this environment's
    // Postgres. The guard must never carry the flag.
    expect(PREVIEW_GUARD_SCRIPT).toContain('compose down --remove-orphans --timeout 30');
    expect(PREVIEW_GUARD_SCRIPT).not.toMatch(/down[^\n]*\s-v\b/);
    expect(PREVIEW_GUARD_SCRIPT).not.toContain('--volumes');
    // Recovery is rate-limited so a stack that cannot come up is not hammered.
    expect(PREVIEW_GUARD_SCRIPT).toContain('RECOVER_COOLDOWN=300');
  });

  it('prunes only unreferenced images, and only when the disk is tight', () => {
    expect(PREVIEW_GUARD_SCRIPT).toContain('PRUNE_AT=75');
    expect(PREVIEW_GUARD_SCRIPT).toContain('docker image prune -af');
    // `df` on the mounted state dir, not on `/` — inside the container `/` is
    // the container's own filesystem and would never look full.
    expect(PREVIEW_GUARD_SCRIPT).toContain('df -P "$DIR"');
  });

  it('validates a patched Caddyfile before asking the edge to reload it', () => {
    const validate = PREVIEW_GUARD_SCRIPT.indexOf('caddy validate --adapter caddyfile --config /dev/stdin');
    const reload = PREVIEW_GUARD_SCRIPT.indexOf('caddy reload --config /etc/caddy/Caddyfile');
    expect(validate).toBeGreaterThan(-1);
    expect(reload).toBeGreaterThan(validate);
    expect(PREVIEW_GUARD_SCRIPT).toContain('lb_try_duration 30s');
  });

  it('is installed idempotently, keyed on its own hash', () => {
    const install = buildPreviewGuardInstall({
      stateDir: '/workspace/kortix-preview',
      instance: 'pr-6998',
      dockerCliImage: 'docker:29.6.1-cli@sha256:' + 'a'.repeat(64),
    });
    // A quoted heredoc: nothing in the guard is expanded by the bootstrap's
    // shell, so its `$DIR` and `$(...)` reach the box intact.
    expect(install).toContain(`<<'${PREVIEW_GUARD_HEREDOC}'`);
    expect(install).toContain(PREVIEW_GUARD_SCRIPT);
    expect(install).toContain(`--label "kortix.guard-sha=$guard_sha"`);
    expect(install).toContain(`if [ "$running_sha" != "$guard_sha" ]; then`);
    expect(install).toContain(`docker rm -f ${PREVIEW_GUARD_CONTAINER}`);
    // Host network is what lets the guard probe 127.0.0.1:8080; the socket
    // and the state dir at the SAME path are what let compose resolve files.
    expect(install).toContain('--network host');
    expect(install).toContain('-v /var/run/docker.sock:/var/run/docker.sock');
    expect(install).toContain('-v /workspace/kortix-preview:/workspace/kortix-preview');
    expect(install).toContain('-e KORTIX_PREVIEW_INSTANCE=pr-6998');
    // The delimiter can never appear inside the script it delimits.
    expect(PREVIEW_GUARD_SCRIPT.split('\n')).not.toContain(PREVIEW_GUARD_HEREDOC);
    expect(() => buildPreviewGuardInstall({ stateDir: '/x', instance: 'bad instance', dockerCliImage: 'docker:cli' })).toThrow(
      /invalid preview instance/,
    );
  });
});
