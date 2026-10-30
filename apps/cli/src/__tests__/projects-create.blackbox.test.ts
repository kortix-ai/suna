import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test.each([false, true])('projects create (json=%s) provisions on the named host and prints only safe project metadata', async (json) => {
  const cwd = mkdtempSync(join(tmpdir(), 'projects-create-'));
  const bodies: unknown[] = [];
  const server = Bun.serve({ port: 0, async fetch(req) {
    expect(req.headers.get('authorization')).toBe('Bearer synthetic-token');
    if (new URL(req.url).pathname === '/v1/projects/synthetic-project') return Response.json({ project_id: 'synthetic-project', name: 'Synthetic', account_id: 'synthetic-account' });
    expect(new URL(req.url).pathname).toBe('/v1/projects/provision');
    bodies.push(await req.json());
    return Response.json({ project_id: 'synthetic-project', name: 'Synthetic', account_id: 'synthetic-account', push_token: 'must-not-print' });
  }});
  const config = join(cwd, 'config.json');
  writeFileSync(config, JSON.stringify({ active: 'other', hosts: { other: { url: 'http://127.0.0.1:9', token: 'wrong-token', account_id: 'wrong-account' }, local: { url: `http://127.0.0.1:${server.port}`, token: 'synthetic-token', account_id: 'synthetic-account' } } }));
  try {
    const proc = Bun.spawn([process.execPath, resolve(import.meta.dir, '../index.ts'), 'projects', 'create', 'Synthetic', '--host', 'local', ...(json ? ['--json'] : [])], {
      cwd, env: { ...process.env, KORTIX_CONFIG_FILE: config, KORTIX_DISABLE_SANDBOX_ENV_FILE: '1', KORTIX_NO_UPDATE_CHECK: '1', NO_COLOR: '1' }, stdout: 'pipe', stderr: 'pipe',
    });
    const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: expect.any(String) });
    if (json) expect(JSON.parse(stdout)).toEqual({ project_id: 'synthetic-project', name: 'Synthetic', account_id: 'synthetic-account' });
    else expect(stdout).toBe('synthetic-project\n');
    expect(stderr).not.toContain('must-not-print');
    expect(stdout).not.toContain('must-not-print');
    const select = Bun.spawn([process.execPath, resolve(import.meta.dir, '../index.ts'), 'projects', 'use', json ? JSON.parse(stdout).project_id : stdout.trim(), '--host', 'local'], { cwd, env: { ...process.env, KORTIX_CONFIG_FILE: config, KORTIX_DISABLE_SANDBOX_ENV_FILE: '1', KORTIX_NO_UPDATE_CHECK: '1' }, stdout: 'pipe', stderr: 'pipe' });
    expect(await select.exited).toBe(0);
    expect(JSON.parse(readFileSync(config, 'utf8')).hosts.local.default_project.project_id).toBe('synthetic-project');
    expect(bodies).toEqual([{ name: 'Synthetic', account_id: 'synthetic-account' }]);
  } finally { server.stop(true); rmSync(cwd, { recursive: true, force: true }); }
});

test.each([[], [''], ['One', 'Two'], ['One', '--host='], ['One', '--account='], ['One', '--host', 'missing']].map((args) => ({ args })))('projects create rejects invalid input without a request: %j', async ({ args }) => {
  const cwd = mkdtempSync(join(tmpdir(), 'projects-create-invalid-'));
  let requests = 0;
  const server = Bun.serve({ port: 0, fetch() { requests++; return Response.json({}); } });
  const config = join(cwd, 'config.json');
  writeFileSync(config, JSON.stringify({ active: 'local', hosts: { local: { url: `http://127.0.0.1:${server.port}`, token: 'synthetic-token' } } }));
  try {
    const proc = Bun.spawn([process.execPath, resolve(import.meta.dir, '../index.ts'), 'projects', 'create', ...args], { cwd, env: { ...process.env, KORTIX_CONFIG_FILE: config, KORTIX_DISABLE_SANDBOX_ENV_FILE: '1', KORTIX_NO_UPDATE_CHECK: '1' }, stdout: 'pipe', stderr: 'pipe' });
    expect(await proc.exited).not.toBe(0);
    expect(requests).toBe(0);
  } finally { server.stop(true); rmSync(cwd, { recursive: true, force: true }); }
});

test.each([200, 403])('projects create reports invalid or refused provisioning (%s)', async (httpStatus) => {
  const cwd = mkdtempSync(join(tmpdir(), 'projects-create-error-'));
  const server = Bun.serve({ port: 0, fetch() { return Response.json({ error: 'Provision unavailable' }, { status: httpStatus }); } });
  const config = join(cwd, 'config.json');
  writeFileSync(config, JSON.stringify({ active: 'local', hosts: { local: { url: `http://127.0.0.1:${server.port}`, token: 'synthetic-token' } } }));
  try {
    const proc = Bun.spawn([process.execPath, resolve(import.meta.dir, '../index.ts'), 'projects', 'create', 'Synthetic', '--host', 'local', '--json'], { cwd, env: { ...process.env, KORTIX_CONFIG_FILE: config, KORTIX_DISABLE_SANDBOX_ENV_FILE: '1', KORTIX_NO_UPDATE_CHECK: '1' }, stdout: 'pipe', stderr: 'pipe' });
    const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    expect(code).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('Provision unavailable');
  } finally { server.stop(true); rmSync(cwd, { recursive: true, force: true }); }
});
