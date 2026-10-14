import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const guard = resolve(root, '.github/actions/state-copy-guard/guard.sh');
const workflowsDir = resolve(root, '.github/workflows');
const GUARD_USES = 'uses: ./.aws-env/.github/actions/state-copy-guard';

/** Every job in every workflow that runs `terraform init` against a real backend. */
function backendInits() {
  const found: { file: string; job: string; text: string }[] = [];
  for (const file of readdirSync(workflowsDir).filter((f) => f.endsWith('.yml'))) {
    const yml = readFileSync(join(workflowsDir, file), 'utf8');
    const jobsAt = yml.search(/^jobs:\s*$/m);
    if (jobsAt < 0) continue;
    const jobs = yml.slice(jobsAt).split(/^(?=  [A-Za-z0-9_-]+:\s*$)/m).slice(1);
    for (const text of jobs) {
      const inits = text.split('\n').filter((l) => /terraform\b.*\binit\b/.test(l) && !l.includes('-backend=false') && !l.trim().startsWith('#'));
      if (inits.length) found.push({ file, job: text.split(':')[0].trim(), text });
    }
  }
  return found;
}

describe('state-copy guard runs before every backend terraform init', () => {
  const inits = backendInits();

  it('finds the two init sites: the reusable apply and the drift plan', () => {
    expect(inits.map((i) => `${i.file}#${i.job}`).sort()).toEqual(['terraform-apply.yml#apply', 'terraform-ci.yml#drift']);
  });

  it.each(inits.map((i) => [`${i.file}#${i.job}`, i] as const))('%s runs the guard before init', (_name, { text }) => {
    const guardAt = text.indexOf(GUARD_USES);
    const initAt = text.search(/terraform\b[^\n]*\binit\b(?![^\n]*-backend=false)/);
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(initAt);
    // The guard comes from the workflow commit's .github/actions checkout, which must not be conditional.
    const checkout = text.slice(0, guardAt).lastIndexOf('path: .aws-env');
    expect(checkout).toBeGreaterThan(-1);
    const checkoutStep = text.slice(text.lastIndexOf('- name:', checkout), checkout);
    expect(checkoutStep).not.toMatch(/^\s+if:/m);
  });

  it('fails the apply and only warns in the read-only drift plan', () => {
    const byFile = Object.fromEntries(inits.map((i) => [i.file, i.text.slice(i.text.indexOf(GUARD_USES), i.text.indexOf(GUARD_USES) + 200)]));
    expect(byFile['terraform-apply.yml']).not.toContain('mode:');
    expect(byFile['terraform-ci.yml']).toMatch(/mode: warn/);
  });
});

/** Runs the REAL guard.sh with a stubbed `aws` that answers get-object-tagging from env. */
function runGuard(backend: string, aws: { out?: string; err?: string; code?: number }, mode = 'fail') {
  const dir = mkdtempSync(join(tmpdir(), 'state-guard-'));
  mkdirSync(join(dir, 'root'));
  writeFileSync(join(dir, 'root', 'backend.tf'), backend);
  const log = join(dir, 'aws.log');
  writeFileSync(log, '');
  writeFileSync(join(dir, 'aws'), `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >>"${log}"\nprintf '%s' "$STUB_OUT"\nprintf '%s' "$STUB_ERR" >&2\nexit "\${STUB_CODE:-0}"\n`);
  chmodSync(join(dir, 'aws'), 0o755);
  const r = spawnSync('bash', [guard], {
    encoding: 'utf8',
    env: { PATH: `${dir}:${process.env.PATH ?? ''}`, ROOT: join(dir, 'root'), MODE: mode,
      STUB_OUT: aws.out ?? '', STUB_ERR: aws.err ?? '', STUB_CODE: String(aws.code ?? 0) },
  });
  return { status: r.status, out: r.stdout + r.stderr, calls: readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) };
}

const backend = (bucket: string, key: string) =>
  `terraform {\n  backend "s3" {\n    bucket       = "${bucket}"\n    key          = "${key}"\n    region       = "eu-west-2"\n  }\n}\n`;
const NEW = 'kortix-terraform-state-eu-west-2-935064898258';

describe('state-copy guard decisions', () => {
  it('skips a root still on the old bucket without calling AWS', () => {
    const r = runGuard(backend('kortix-terraform-state', 'prod/ecs-api.tfstate'), {});
    expect(r.status).toBe(0);
    expect(r.calls).toEqual([]);
  });

  it('passes when the old key version carries statemove=copied', () => {
    const r = runGuard(backend(NEW, 'prod/ecs-api.tfstate'), { out: 'copied' });
    expect(r.status).toBe(0);
    expect(r.calls[0]).toContain('--bucket kortix-terraform-state --key prod/ecs-api.tfstate');
  });

  it('passes when the old key is gone', () => {
    const r = runGuard(backend(NEW, 'prod/ecs-api.tfstate'), { err: 'An error occurred (NoSuchKey) when calling the GetObjectTagging operation', code: 254 });
    expect(r.status).toBe(0);
  });

  it('fails and names the group when the old key was written after the copy', () => {
    const r = runGuard(backend(NEW, 'staging-eu-west-2/ecs-api.tfstate'), { out: 'None' });
    expect(r.status).toBe(1);
    expect(r.out).toContain('::error');
    expect(r.out).toContain('copy-states.mjs staging, then deny-old-keys.mjs staging');
  });

  it('fails closed when the tags cannot be read', () => {
    const r = runGuard(backend(NEW, 'security/baseline.tfstate'), { err: 'An error occurred (AccessDenied)', code: 254 });
    expect(r.status).toBe(1);
    expect(r.out).toContain('cannot read the tags');
  });

  it('only warns in warn mode', () => {
    const r = runGuard(backend(NEW, 'dev-us-east-2/ecs-api.tfstate'), { out: 'None' }, 'warn');
    expect(r.status).toBe(0);
    expect(r.out).toContain('::warning');
    expect(r.out).toContain('copy-states.mjs dev');
  });
});
