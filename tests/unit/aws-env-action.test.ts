import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const actionDir = resolve(root, '.github/actions/aws-env');
const script = resolve(actionDir, 'fetch.sh');
const workflowsDir = resolve(root, '.github/workflows');

/**
 * Drives the REAL `.github/actions/aws-env/fetch.sh` with a stubbed `aws`
 * executable first on PATH. The stub serves each blob from a JSON file named
 * after the secret id and logs every call, so the test can count reads.
 */
const AWS_STUB = String.raw`#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$AWS_STUB_LOG"
id=""
while [ $# -gt 0 ]; do
  if [ "$1" = "--secret-id" ]; then id="$2"; fi
  shift
done
if [ -f "$AWS_STUB_DIR/$id.json" ]; then
  cat "$AWS_STUB_DIR/$id.json"
  exit 0
fi
echo "An error occurred (ResourceNotFoundException): Secrets Manager can't find the specified secret." >&2
exit 254
`;

const PEM = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\nAAECggEBAKj34GkxFhD90vcNLYLInFEX\n-----END PRIVATE KEY-----\n';

const BLOBS: Record<string, Record<string, unknown>> = {
  'kortix-ci-env': {
    DOCKERHUB_TOKEN: 'dckr_pat_value_one',
    PREVIEW_KORTIX_GITHUB_APP_PRIVATE_KEY: PEM,
    PERCENT_VALUE: 'p%25q%value',
    EMPTY_VALUE: '',
  },
  'kortix-staging-env': {
    DATABASE_URL: 'postgresql://user:staging-db-password@db.example.test:5432/postgres',
    SUPABASE_URL: 'https://staging-ref.supabase.co',
  },
};

function run(keys: string, env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aws-env-'));
  const stub = join(dir, 'aws');
  writeFileSync(stub, AWS_STUB);
  chmodSync(stub, 0o755);
  for (const [id, blob] of Object.entries(BLOBS)) {
    writeFileSync(join(dir, `${id}.json`), JSON.stringify(blob));
  }
  const githubEnv = join(dir, 'github_env');
  const log = join(dir, 'aws.log');
  writeFileSync(githubEnv, '');
  writeFileSync(log, '');
  const result = spawnSync('bash', [script], {
    encoding: 'utf8',
    env: {
      PATH: `${dir}:${process.env.PATH ?? ''}`,
      HOME: dir,
      GITHUB_ENV: githubEnv,
      AWS_STUB_DIR: dir,
      AWS_STUB_LOG: log,
      AWS_ENV_KEYS: keys,
      AWS_ENV_REGION: 'us-west-2',
      ...env,
    },
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    githubEnv: readFileSync(githubEnv, 'utf8'),
    awsCalls: readFileSync(log, 'utf8').trim().split('\n').filter(Boolean),
  };
}

/** Parses GITHUB_ENV the way the runner does: NAME=value or NAME<<DELIM ... DELIM. */
function parseGithubEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const heredoc = /^([^=<]+)<<(.+)$/.exec(line);
    if (heredoc) {
      const [, name, delim] = heredoc;
      const body: string[] = [];
      i++;
      while (i < lines.length && lines[i] !== delim) body.push(lines[i++]);
      if (lines[i] !== delim) throw new Error(`unterminated heredoc for ${name}`);
      out[name] = body.join('\n');
      continue;
    }
    const eq = line.indexOf('=');
    out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

function allValues(): string[] {
  return Object.values(BLOBS)
    .flatMap((blob) => Object.values(blob))
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
}

/** stdout minus the mask commands: what a reader of the log actually sees. */
function visibleOutput(stdout: string): string {
  return stdout
    .split('\n')
    .filter((line) => !line.startsWith('::add-mask::'))
    .join('\n');
}

describe('aws-env composite action — fetch.sh', () => {
  it('reads a bare NAME from kortix-ci-env and exports it', () => {
    const r = run('DOCKERHUB_TOKEN\n');
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(parseGithubEnv(r.githubEnv)).toEqual({ DOCKERHUB_TOKEN: 'dckr_pat_value_one' });
    expect(r.stdout).toContain('DOCKERHUB_TOKEN <- kortix-ci-env:DOCKERHUB_TOKEN (18 chars)');
    expect(r.awsCalls).toHaveLength(1);
    expect(r.awsCalls[0]).toContain('secretsmanager get-secret-value --region us-west-2 --secret-id kortix-ci-env');
  });

  it('maps NAME=blob:KEY across several blobs with one read per distinct blob', () => {
    const r = run(
      [
        '  # comment lines and blank lines are ignored',
        '',
        'DOCKERHUB_TOKEN',
        'KE2E_DATABASE_URL = kortix-staging-env:DATABASE_URL',
        'KE2E_SUPABASE_URL=kortix-staging-env:SUPABASE_URL',
      ].join('\n'),
    );
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(parseGithubEnv(r.githubEnv)).toEqual({
      DOCKERHUB_TOKEN: 'dckr_pat_value_one',
      KE2E_DATABASE_URL: BLOBS['kortix-staging-env'].DATABASE_URL,
      KE2E_SUPABASE_URL: BLOBS['kortix-staging-env'].SUPABASE_URL,
    });
    expect(r.stdout).toContain('KE2E_DATABASE_URL <- kortix-staging-env:DATABASE_URL (');
    expect(r.awsCalls).toHaveLength(2);
    expect(r.awsCalls.filter((c) => c.includes('--secret-id kortix-staging-env'))).toHaveLength(1);
  });

  it('leaves an optional `?` key unset with a notice, and exports the rest', () => {
    const r = run('KE2E_OWNER_EMAIL?\nAUTH_HOOK=kortix-staging-env:AUTH_EMAIL_HOOK_SECRET?\nEMPTY_VALUE?\nDOCKERHUB_TOKEN');
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(parseGithubEnv(r.githubEnv)).toEqual({ DOCKERHUB_TOKEN: 'dckr_pat_value_one' });
    expect(r.stdout).toContain('::notice::aws-env: kortix-ci-env has no KE2E_OWNER_EMAIL; KE2E_OWNER_EMAIL left unset');
    expect(r.stdout).toContain('::notice::aws-env: kortix-staging-env has no AUTH_EMAIL_HOOK_SECRET; AUTH_HOOK left unset');
    expect(r.stdout).toContain('::notice::aws-env: kortix-ci-env has no EMPTY_VALUE; EMPTY_VALUE left unset');
  });

  it('fails closed on a missing or empty required key and exports nothing after it', () => {
    const missing = run('DOCKERHUB_TOKEN\nNOT_THERE\nKE2E_SUPABASE_URL=kortix-staging-env:SUPABASE_URL');
    expect(missing.status).not.toBe(0);
    expect(missing.stdout).toContain('::error::aws-env: kortix-ci-env has no non-empty key NOT_THERE (for NOT_THERE)');
    expect(parseGithubEnv(missing.githubEnv)).not.toHaveProperty('KE2E_SUPABASE_URL');

    const empty = run('EMPTY_VALUE');
    expect(empty.status).not.toBe(0);
    expect(empty.stdout).toContain('::error::aws-env: kortix-ci-env has no non-empty key EMPTY_VALUE');
  });

  it('fails closed when a blob cannot be read, even if every key is optional', () => {
    const r = run('X=kortix-missing-env:X?');
    expect(r.status).not.toBe(0);
    expect(r.stdout).toContain("::error::aws-env: cannot read Secrets Manager blob 'kortix-missing-env'");
    expect(r.githubEnv).toBe('');
  });

  it('rejects malformed lines before any AWS call', () => {
    for (const bad of ['X=kortix-staging-env', 'BAD-NAME', '1X', '=blob:KEY', 'X=:KEY', 'X=blob:']) {
      const r = run(bad);
      expect(r.status, bad).not.toBe(0);
      expect(r.stdout, bad).toContain('::error::aws-env:');
      expect(r.awsCalls, bad).toHaveLength(0);
    }
    const none = run('\n  \n# only a comment\n');
    expect(none.status).not.toBe(0);
    expect(none.stdout).toContain('::error::aws-env: no keys requested');
  });

  it('carries a multi-line PEM through GITHUB_ENV byte for byte', () => {
    const r = run('PREVIEW_KORTIX_GITHUB_APP_PRIVATE_KEY');
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(parseGithubEnv(r.githubEnv).PREVIEW_KORTIX_GITHUB_APP_PRIVATE_KEY).toBe(PEM);
    expect(r.stdout).toContain(`PREVIEW_KORTIX_GITHUB_APP_PRIVATE_KEY <- kortix-ci-env:PREVIEW_KORTIX_GITHUB_APP_PRIVATE_KEY (${PEM.length} chars)`);
    // The heredoc delimiter is random per key, not a fixed word a value could contain.
    const delims = [...r.githubEnv.matchAll(/<<(\S+)/g)].map((m) => m[1]);
    expect(delims[0]).toMatch(/^AWS_ENV_EOF_[0-9a-f]{32}$/);
    expect(PEM).not.toContain(delims[0]);
  });

  it('masks every non-empty line of every value before printing anything else', () => {
    const r = run(
      'DOCKERHUB_TOKEN\nPREVIEW_KORTIX_GITHUB_APP_PRIVATE_KEY\nPERCENT_VALUE\nDB=kortix-staging-env:DATABASE_URL',
    );
    expect(r.status, r.stderr + r.stdout).toBe(0);
    const masks = r.stdout
      .split('\n')
      .filter((line) => line.startsWith('::add-mask::'))
      .map((line) => line.slice('::add-mask::'.length));
    for (const line of PEM.split('\n').filter(Boolean)) expect(masks).toContain(line);
    expect(masks).toContain('dckr_pat_value_one');
    expect(masks).toContain(BLOBS['kortix-staging-env'].DATABASE_URL);
    // `%` is escaped, so the runner unescapes the mask back to the real value.
    expect(masks).toContain('p%2525q%25value');
    // Each value's masks come before its report line.
    const firstReport = r.stdout.indexOf(' <- ');
    expect(r.stdout.indexOf('::add-mask::dckr_pat_value_one')).toBeLessThan(firstReport);
  });

  it('never prints a value outside a mask command', () => {
    const r = run(
      'DOCKERHUB_TOKEN\nPREVIEW_KORTIX_GITHUB_APP_PRIVATE_KEY\nPERCENT_VALUE\nDB=kortix-staging-env:DATABASE_URL\nS=kortix-staging-env:SUPABASE_URL\nMISSING?',
    );
    expect(r.status, r.stderr + r.stdout).toBe(0);
    const visible = visibleOutput(r.stdout) + r.stderr;
    for (const value of allValues()) {
      for (const line of value.split('\n').filter(Boolean)) expect(visible).not.toContain(line);
    }
  });

  it('uses the OIDC step credentials when present and the job credentials otherwise', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aws-env-creds-'));
    const stub = join(dir, 'aws');
    writeFileSync(stub, `#!/usr/bin/env bash\nprintf '%s|%s|%s' "\${AWS_ACCESS_KEY_ID:-}" "\${AWS_SESSION_TOKEN:-}" "\${AWS_ENV_ACCESS_KEY_ID:-unset}" >"${dir}/seen"\necho '{"K":"v"}'\n`);
    chmodSync(stub, 0o755);
    const githubEnv = join(dir, 'github_env');
    const base = { PATH: `${dir}:${process.env.PATH ?? ''}`, GITHUB_ENV: githubEnv, AWS_ENV_KEYS: 'K' };

    writeFileSync(githubEnv, '');
    let r = spawnSync('bash', [script], {
      encoding: 'utf8',
      env: { ...base, AWS_ACCESS_KEY_ID: 'JOBKEY', AWS_ENV_ACCESS_KEY_ID: 'OIDCKEY', AWS_ENV_SECRET_ACCESS_KEY: 's', AWS_ENV_SESSION_TOKEN: 'tok' },
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(readFileSync(join(dir, 'seen'), 'utf8')).toBe('OIDCKEY|tok|unset');

    writeFileSync(githubEnv, '');
    r = spawnSync('bash', [script], {
      encoding: 'utf8',
      env: { ...base, AWS_ACCESS_KEY_ID: 'JOBKEY', AWS_ENV_ACCESS_KEY_ID: '', AWS_ENV_SECRET_ACCESS_KEY: '', AWS_ENV_SESSION_TOKEN: '' },
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(readFileSync(join(dir, 'seen'), 'utf8')).toBe('JOBKEY||unset');
  });

  it('action.yml keeps the job credentials intact and defaults to the ecs-deploy role', () => {
    const action = readFileSync(resolve(actionDir, 'action.yml'), 'utf8');
    expect(action).toContain('default: arn:aws:iam::935064898258:role/kortix-gha-ecs-deploy');
    expect(action).toContain('default: us-west-2');
    expect(action).toContain('output-env-credentials: false');
    expect(action).toContain('output-credentials: true');
    expect(action).toContain("if: inputs.role-to-assume != ''");
    expect(action).toMatch(/uses: aws-actions\/configure-aws-credentials@[0-9a-f]{40} # v6/);
    expect(action).toContain('shell: bash');
  });
});

describe('workflows read credentials from AWS, not GitHub', () => {
  const files = readdirSync(workflowsDir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));

  it('references no GitHub secret except GITHUB_TOKEN and temporary `|| secrets.X` fallbacks', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const lines = readFileSync(join(workflowsDir, file), 'utf8').split('\n');
      lines.forEach((line, i) => {
        const stripped = line
          .replace(/secrets\.GITHUB_TOKEN/g, '')
          .replace(/\|\|\s*secrets\.[A-Z0-9_]+/g, '');
        if (/(?<![\w.-])secrets\.[A-Za-z_]/.test(stripped)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  const USES = 'uses: ./.aws-env/.github/actions/aws-env';

  /** Top-level `jobs:` entries as { name, text }, split on two-space keys. */
  function jobsOf(text: string): { name: string; text: string }[] {
    const body = text.slice(text.search(/^jobs:\n/m));
    const heads = [...body.matchAll(/^ {2}([A-Za-z0-9_-]+):\n/gm)];
    return heads.map((m, i) => ({
      name: m[1],
      text: body.slice(m.index, i + 1 < heads.length ? heads[i + 1].index : undefined),
    }));
  }

  /** The `permissions:` mapping at `indent` spaces, or null when absent. */
  function permissionsAt(text: string, indent: number): string[] | null {
    const pad = ' '.repeat(indent);
    const lines = text.split('\n');
    const at = lines.findIndex((l) => l === `${pad}permissions:`);
    if (at === -1) return null;
    const out: string[] = [];
    for (const line of lines.slice(at + 1)) {
      if (!line.startsWith(`${pad}  `) || line.trim() === '') break;
      if (!line.trim().startsWith('#')) out.push(line.trim());
    }
    return out;
  }

  const users = files
    .map((file) => ({ file, text: readFileSync(join(workflowsDir, file), 'utf8') }))
    .filter(({ text }) => text.includes(USES));

  it('finds the workflows that use aws-env (guards the checks below from passing vacuously)', () => {
    expect(users.length).toBeGreaterThanOrEqual(20);
  });

  it('every job that calls aws-env can mint an OIDC token', () => {
    const missing: string[] = [];
    for (const { file, text } of users) {
      const workflowPerms = permissionsAt(text.slice(0, text.search(/^jobs:\n/m)), 0);
      for (const job of jobsOf(text)) {
        if (!job.text.includes(USES)) continue;
        const perms = permissionsAt(job.text, 4) ?? workflowPerms;
        if (!perms?.some((p) => p.startsWith('id-token: write'))) missing.push(`${file}:${job.name}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('every aws-env step runs from a checkout of the workflow commit in .aws-env', () => {
    const bad: string[] = [];
    let count = 0;
    for (const { file, text } of users) {
      let from = 0;
      for (;;) {
        const at = text.indexOf(USES, from);
        if (at === -1) break;
        count++;
        from = at + USES.length;
        const checkout = text.lastIndexOf('- name: Check out the aws-env action', at);
        const between = text.slice(checkout, at);
        // Exactly one step (the aws-env read) may start between the two.
        const steps = between.match(/\n +- /g) ?? [];
        if (
          checkout === -1 ||
          steps.length !== 1 ||
          !between.includes('ref: ${{ github.workflow_sha }}') ||
          !between.includes('path: .aws-env') ||
          !between.includes('sparse-checkout: .github/actions') ||
          !between.includes('persist-credentials: false')
        ) {
          bad.push(`${file}@${at}`);
        }
      }
    }
    expect(count).toBeGreaterThanOrEqual(40);
    expect(bad).toEqual([]);
  });

  it('never gives a deploy-preview job that checks out pull request code an OIDC token', () => {
    const text = readFileSync(join(workflowsDir, 'deploy-preview.yml'), 'utf8');
    const prJobs = jobsOf(text).filter((job) => job.text.includes('ref: ${{ needs.authorize.outputs.sha }}'));
    expect(prJobs.map((job) => job.name).sort()).toEqual(['build-api', 'build-gateway', 'build-web']);
    for (const job of prJobs) {
      expect(job.text, job.name).not.toContain('id-token');
      expect(job.text, job.name).not.toContain('aws-env');
    }
    for (const job of jobsOf(text).filter((j) => j.text.includes(USES))) {
      expect(job.text, job.name).toMatch(/ref: (\$\{\{ github\.event\.repository\.default_branch \}\}|main)\n/);
    }
  });
});
