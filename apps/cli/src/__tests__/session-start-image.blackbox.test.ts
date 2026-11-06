/**
 * A session that waits on its sandbox image says which image step it is in.
 *
 * `POST /v1/projects/:id/sessions/:sid/start` answers `boot.image` while the
 * stage is `provisioning` (`SessionStartImageStep` in @kortix/api-contract).
 * The real CLI runs against a fake API that scripts the `/start` answers, and
 * every assertion is on the CLI's exit code, stdout and stderr.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI_ENTRY = join(resolve(import.meta.dir, '..', '..'), 'src', 'index.ts');
const PROJECT = '00000000-0000-4000-a000-000000000311';
const SESSION = '7a01e9ef-0000-4000-a000-000000000511';
const SHORT = '7a01e9ef';
const ACCOUNT = '00000000-0000-4000-a000-000000000411';

/** `2026-01-01T00:<mm>:<ss>.000Z`. */
const at = (mm: number, ss: number) =>
  `2026-01-01T00:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.000Z`;

/** A `/start` answer while provisioning; `image` null is the field an older API omits. */
function provisioning(
  observed: string,
  image: { state: string; image: string | null; since: string } | null | undefined,
) {
  return {
    stage: 'provisioning',
    agent_name: 'kortix',
    retriable: true,
    sandbox: null,
    runtime_session_id: null,
    observed_at: observed,
    action: 'none',
    boot: {
      phase: 'provisioning',
      since: at(0, 0),
      actively_starting: true,
      ...(image === undefined ? {} : { image }),
    },
  };
}

const STARTING = { stage: 'starting', agent_name: 'kortix', retriable: true, runtime_session_id: null, boot: { phase: 'booting', since: at(3, 0), actively_starting: true, image: null } };
const READY = { stage: 'ready', agent_name: 'kortix', retriable: false, runtime_session_id: 'ses_rt', boot: { phase: 'ready', since: at(3, 5), actively_starting: false, image: null } };

/** Every image state once, plus one repeat that must not print a line. */
const IMAGE_WALK = [
  provisioning(at(0, 1), { state: 'resolving', image: null, since: at(0, 0) }),
  provisioning(at(0, 44), { state: 'building', image: 'tpl-v2', since: at(0, 2) }),
  provisioning(at(1, 30), { state: 'building', image: 'tpl-v2', since: at(0, 2) }),
  provisioning(at(1, 45), { state: 'serving_last_ready', image: 'tpl-v1', since: at(1, 40) }),
  provisioning(at(2, 7), { state: 'copying_to_region', image: 'tpl-v2', since: at(2, 0) }),
  provisioning(at(2, 13), { state: 'waiting_for_provider', image: 'tpl-v2', since: at(2, 10) }),
  provisioning(at(2, 20), { state: 'waiting_for_build', image: 'tpl-v2', since: at(2, 15) }),
  STARTING,
  READY,
];

const IMAGE_WALK_LINES = [
  'provisioning · choosing the image (0:01)',
  'provisioning · building the first image for this workspace (0:42)',
  'provisioning · starting from the last ready image while the new one builds (0:05)',
  "provisioning · copying the image to the session's region (0:07)",
  'provisioning · waiting for the provider to finish the image (retrying, 0:03)',
  'provisioning · waiting for the first image for this workspace to finish building (0:05)',
  'starting',
  'ready',
];

let tmp: string;
let server: ReturnType<typeof Bun.serve> | null = null;
let startReplies: unknown[] = [];
let startCalls = 0;
let sessionStatus = 'provisioning';

function sessionRow() {
  return {
    session_id: SESSION,
    account_id: ACCOUNT,
    project_id: PROJECT,
    branch_name: SESSION,
    base_ref: 'main',
    sandbox_provider: 'platinum',
    sandbox_id: null,
    sandbox_url: null,
    runtime_session_id: null,
    name: 'Image wait',
    custom_name: null,
    agent_name: 'kortix',
    status: sessionStatus,
    error: null,
    metadata: {},
    sharing: { mode: 'private', ownerId: 'user-1' },
    created_at: at(0, 0),
    updated_at: at(0, 0),
  };
}

function startServer(): string {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      const project = `/v1/workspaces/${PROJECT}`;
      if (req.method === 'POST' && path === `${project}/sessions`) {
        return Response.json(sessionRow(), { status: 201 });
      }
      if (req.method === 'POST' && path === `${project}/sessions/${SESSION}/start`) {
        startCalls += 1;
        const reply = startReplies.shift() ?? READY;
        if ((reply as { stage: string }).stage === 'ready') sessionStatus = 'running';
        return Response.json(reply);
      }
      if (req.method === 'GET' && path === `${project}/sessions/${SESSION}`) {
        return Response.json(sessionRow());
      }
      if (req.method === 'GET' && path === `${project}/sessions`) {
        return Response.json({ sessions: [sessionRow()] });
      }
      // model-picker, project read, …: absent on this fake API, which the CLI tolerates.
      return Response.json({ error: `unexpected ${req.method} ${path}` }, { status: 404 });
    },
  });
  return `http://127.0.0.1:${server.port}`;
}

function writeConfig(apiBase: string): string {
  const path = join(tmp, 'config.json');
  writeFileSync(
    path,
    JSON.stringify({
      active: 'test',
      hosts: {
        test: {
          url: apiBase,
          token: 'kortix_pat_image',
          user_id: 'user-1',
          user_email: 'user@example.test',
          account_id: ACCOUNT,
          logged_in_at: at(0, 0),
        },
      },
    }),
  );
  return path;
}

let config = '';

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    KORTIX_NO_UPDATE_CHECK: '1',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    KORTIX_DISABLE_SANDBOX_ENV_FILE: '1',
    KORTIX_CONFIG_FILE: config,
    KORTIX_CLI_START_POLL_MS: '0',
  };
  for (const key of ['KORTIX_API_URL', 'KORTIX_CLI_TOKEN', 'KORTIX_FRONTEND_URL', 'KORTIX_PROJECT_ID', 'KORTIX_TOKEN', 'BASH_ENV']) {
    delete env[key];
  }
  const proc = Bun.spawn({
    cmd: [process.execPath, CLI_ENTRY, ...args],
    cwd: tmp,
    env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timeout = setTimeout(() => proc.kill(), 20_000);
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]).finally(() => clearTimeout(timeout));
  return { code, stdout, stderr };
}

/** The stderr lines that start with `prefix`, prefix removed. */
function progressLines(stderr: string, prefix: string): string[] {
  return stderr
    .split('\n')
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length));
}

const P = ['--project', PROJECT];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'kortix-start-image-'));
  startReplies = [];
  startCalls = 0;
  sessionStatus = 'provisioning';
  config = writeConfig(startServer());
});

afterEach(() => {
  server?.stop(true);
  server = null;
  rmSync(tmp, { recursive: true, force: true });
});

describe('kortix sessions new --wait', () => {
  test('prints each image step once with its elapsed time, then exits 0 when ready', async () => {
    startReplies = [...IMAGE_WALK];
    const r = await runCli(['sessions', 'new', '--prompt', 'hi', '--wait', ...P]);
    expect(r.code).toBe(0);
    expect(startCalls).toBe(IMAGE_WALK.length);
    expect(r.stderr).toContain(`Session ${SESSION}: created (provisioning); waiting for readiness…`);
    expect(progressLines(r.stderr, `Session ${SESSION}: `).slice(1)).toEqual(IMAGE_WALK_LINES);
    expect(r.stdout).toContain(`Session started ${SHORT}`);
  });

  test('--json prints the session object unchanged; the steps stay on stderr', async () => {
    startReplies = [...IMAGE_WALK];
    const r = await runCli(['sessions', 'new', '--prompt', 'hi', '--wait', '--json', ...P]);
    expect(r.code).toBe(0);
    const printed = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(printed).toMatchObject({ session_id: SESSION, status: 'running' });
    expect(printed).not.toHaveProperty('boot');
    expect(progressLines(r.stderr, `Session ${SESSION}: `)).toContain(IMAGE_WALK_LINES[1]!);
  });

  test('an API without boot.image prints the bare stage; an unknown image state prints humanized', async () => {
    startReplies = [
      provisioning(at(0, 1), undefined),
      provisioning(at(0, 9), { state: 'pulling_layers', image: null, since: at(0, 4) }),
      READY,
    ];
    const r = await runCli(['sessions', 'new', '--prompt', 'hi', '--wait', ...P]);
    expect(r.code).toBe(0);
    expect(progressLines(r.stderr, `Session ${SESSION}: `).slice(1)).toEqual([
      'provisioning',
      'provisioning · pulling layers (0:05)',
      'ready',
    ]);
  });
});

describe('kortix sessions start', () => {
  test('--wait prints each image step once, then reports ready', async () => {
    startReplies = [...IMAGE_WALK];
    const r = await runCli(['sessions', 'start', SESSION, '--wait', ...P]);
    expect(r.code).toBe(0);
    // `ready` ends the loop, so the ready line is the stdout verdict, not a step.
    expect(progressLines(r.stderr, `Session ${SHORT}: `)).toEqual(IMAGE_WALK_LINES.slice(0, -1));
    expect(r.stdout).toContain(`${SHORT} is ready`);
  });

  test('without --wait names the image step in its one-line answer', async () => {
    startReplies = [IMAGE_WALK[1]];
    const r = await runCli(['sessions', 'start', SESSION, ...P]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(
      `${SHORT} is provisioning · building the first image for this workspace (0:42) — re-run with --wait`,
    );
  });

  test('--json prints the /start payload with boot.image unchanged', async () => {
    startReplies = [IMAGE_WALK[3]];
    const r = await runCli(['sessions', 'start', SESSION, '--json', ...P]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(IMAGE_WALK[3]);
    expect(JSON.parse(r.stdout).boot.image).toEqual({ state: 'serving_last_ready', image: 'tpl-v1', since: at(1, 40) });
  });

  test('--wait --json prints no step lines, only the final payload', async () => {
    startReplies = [...IMAGE_WALK];
    const r = await runCli(['sessions', 'start', SESSION, '--wait', '--json', ...P]);
    expect(r.code).toBe(0);
    expect(progressLines(r.stderr, `Session ${SHORT}: `)).toEqual([]);
    expect(JSON.parse(r.stdout)).toEqual(READY);
  });
});
