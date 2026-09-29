import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { JOB_CANCEL, JOB_LAUNCH, JOB_POLL, parseJobPoll, renderJob } from './jobs';

const SEP = '--kortix-mcp-test--';

describe('parseJobPoll', () => {
  test('a finished job: exit code, sizes, both streams', () => {
    const out = `done 3\n11 4\n${SEP}\nhi "there"\n\n${SEP}\nerr\n`;
    expect(parseJobPoll(out, SEP)).toEqual({ state: 'done', exit: '3', sizes: [11, 4], stdout: 'hi "there"\n', stderr: 'err' });
  });

  test('a running job and a missing one', () => {
    expect(parseJobPoll(`running\n0 0\n${SEP}\n\n${SEP}\n`, SEP)).toMatchObject({ state: 'running', exit: null, stdout: '', stderr: '' });
    expect(parseJobPoll('missing\n', SEP)).toEqual({ state: 'missing' });
  });
});

describe('renderJob', () => {
  test('a timeout names itself; a running job names its job_id and how to continue', () => {
    expect(renderJob('a'.repeat(16), { state: 'done', exit: '124', sizes: [0, 0], stdout: '', stderr: '' }, 1)).toBe('exit_code: 124 (timed out)');
    const running = renderJob('b'.repeat(16), { state: 'running', exit: null, sizes: [5, 0], stdout: 'step1', stderr: '' }, 50_000);
    expect(running).toContain(`job_id: ${'b'.repeat(16)}`);
    expect(running).toContain('stdout:\nstep1');
  });
});

// The shipped scripts, run the way the sandbox daemon's env-rpc `exec` runs
// them: `bash -lc <script>` with the call's env merged in. Linux only — the
// sandbox is ubuntu:24.04, and macOS has neither setsid nor GNU timeout.
describe.skipIf(process.platform !== 'linux')('job scripts in a real shell', () => {
  const home = mkdtempSync(join(tmpdir(), 'kmcp-'));
  const sh = (script: string, env: Record<string, string>, cwd = home) =>
    spawnSync('bash', ['-lc', script], { cwd, env: { ...process.env, HOME: home, ...env }, encoding: 'utf8' }).stdout;
  const poll = (job: string) => parseJobPoll(sh(JOB_POLL, { KMCP_JOB: job, KMCP_TAIL: '1000', KMCP_SEP: SEP }), SEP);
  const waitDone = async (job: string, ms = 10_000) => {
    const until = Date.now() + ms;
    for (;;) {
      const state = poll(job);
      if (state.state !== 'running' || Date.now() > until) return state;
      await Bun.sleep(100);
    }
  };

  test('launch returns at once; the job keeps its quotes, stderr, exit code and cwd', async () => {
    const started = Date.now();
    sh(JOB_LAUNCH, { KMCP_JOB: 'j1', KMCP_CMD: `sleep 1; pwd; echo 'a "b"'; echo e >&2; exit 3`, KMCP_TIMEOUT: '60' }, '/tmp');
    expect(Date.now() - started).toBeLessThan(900);
    expect(poll('j1').state).toBe('running');
    expect(await waitDone('j1')).toMatchObject({ state: 'done', exit: '3', stdout: '/tmp\na "b"\n', stderr: 'e' });
  });

  test('timeout_seconds kills a command with exit 124', async () => {
    sh(JOB_LAUNCH, { KMCP_JOB: 'j2', KMCP_CMD: 'sleep 30', KMCP_TIMEOUT: '1' });
    expect(await waitDone('j2')).toMatchObject({ state: 'done', exit: '124' });
  });

  test('cancel stops the whole tree, including what timeout put in its own process group', async () => {
    sh(JOB_LAUNCH, { KMCP_JOB: 'j3', KMCP_CMD: 'sleep 301 & sleep 302', KMCP_TIMEOUT: '600' });
    await Bun.sleep(300);
    expect(sh(JOB_CANCEL, { KMCP_JOB: 'j3' }).trim()).toBe('cancelled');
    expect(poll('j3')).toMatchObject({ state: 'done', exit: 'cancelled' });
    expect(spawnSync('pgrep', ['-x', '-f', 'sleep 30[12]']).status).toBe(1);
    expect(sh(JOB_CANCEL, { KMCP_JOB: 'j3' }).trim()).toBe('finished');
  });

  test('the launch internals do not leak into the command environment', async () => {
    sh(JOB_LAUNCH, { KMCP_JOB: 'j4', KMCP_CMD: 'env | grep -c KMCP', KMCP_TIMEOUT: '60' });
    expect(await waitDone('j4')).toMatchObject({ state: 'done', stdout: '0\n' });
  });

  test('a launch deletes job dirs older than 24 h and keeps recent ones', async () => {
    const jobs = join(home, '.cache/kortix-mcp/jobs');
    mkdirSync(join(jobs, 'old'), { recursive: true });
    // Backdate in-process and prove it took: `touch -d '2 days ago'` depends on
    // the runner's coreutils and its exit status was never checked, so a CI
    // failure could not say whether the mtime or the cleanup was wrong.
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    utimesSync(join(jobs, 'old'), twoDaysAgo, twoDaysAgo);
    expect(Date.now() - statSync(join(jobs, 'old')).mtimeMs).toBeGreaterThan(24 * 60 * 60 * 1000);
    sh(JOB_LAUNCH, { KMCP_JOB: 'j5', KMCP_CMD: 'true', KMCP_TIMEOUT: '60' });
    expect(existsSync(join(jobs, 'old'))).toBe(false);
    expect(existsSync(join(jobs, 'j5'))).toBe(true);
  });

  test('a cut tail starts on a line boundary, or says it started mid-line', async () => {
    sh(JOB_LAUNCH, { KMCP_JOB: 'j6', KMCP_CMD: 'for i in $(seq 1 400); do echo line$i; done; head -c 3000 /dev/zero | tr "\\0" x >&2', KMCP_TIMEOUT: '60' });
    const done = await waitDone('j6');
    if (done.state === 'missing') throw new Error('job missing');
    expect(done.sizes[0]).toBeGreaterThan(1000);
    expect(done.stdout.split('\n').filter(Boolean).every((l) => /^line\d+$/.test(l))).toBe(true);
    expect(done.stderr).toStartWith('(started mid-line) x');
  });

  test('an unknown job is missing', () => {
    expect(poll('nope').state).toBe('missing');
  });
});
