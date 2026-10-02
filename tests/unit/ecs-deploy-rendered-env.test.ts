import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const script = resolve(root, 'infra/scripts/ecs-deploy.sh');

/**
 * Deploy Dev's release gate runs the new API image with the environment the
 * roll will register, rendered by `ecs-deploy.sh --dry-run` into
 * ECS_DEPLOY_RENDERED_ENV_FILE. These runs drive the REAL script with a stubbed
 * `aws` on PATH (no credentials exist here) and read that file.
 */
const AWS_STUB = String.raw`#!/usr/bin/env bash
set -euo pipefail
ARGS="$*"
case "$ARGS" in
  *"describe-services"*"services[0].status"*) printf 'ACTIVE' ;;
  *"describe-services"*"services[0].taskDefinition"*)
    printf 'arn:aws:ecs:us-west-2:111:task-definition/kortix-dev:41' ;;
  *"secretsmanager describe-secret"*)
    printf 'arn:aws:secretsmanager:us-west-2:111:secret:kortix-dev-env-AbCdEf' ;;
  *"secretsmanager get-secret-value"*) printf '{"SECRET_ONLY":"blob-value"}' ;;
  *"describe-task-definition"*)
    cat <<'JSON'
{"taskDefinitionArn":"arn:aws:ecs:us-west-2:111:task-definition/kortix-dev:41",
"family":"kortix-dev","revision":41,"status":"ACTIVE","cpu":"1024","memory":"4096",
"containerDefinitions":[{"name":"api","image":"kortix/kortix-api:dev-old",
"environment":[
  {"name":"KEEP","value":"from-the-running-revision"},
  {"name":"KORTIX_PLATINUM_US_REGION","value":"us-west"},
  {"name":"KORTIX_VERSION","value":"0.0.1-dev.old"},
  {"name":"KORTIX_COMMIT","value":"old-commit"}],
"secrets":[{"name":"KORTIX_ENV_JSON","valueFrom":"arn:old"}]}]}
JSON
    ;;
  *) echo "stub aws: unhandled call: $ARGS" >&2; exit 64 ;;
esac
`;

function dryRun(renderedFile: string | null) {
  const dir = mkdtempSync(join(tmpdir(), 'ecs-render-'));
  const stub = join(dir, 'aws');
  writeFileSync(stub, AWS_STUB);
  chmodSync(stub, 0o755);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${dir}:${process.env.PATH}`,
    KORTIX_ECS_ENV_OVERRIDES: '{"KORTIX_PLATINUM_US_REGION":"us-east","ADDED":"by-override"}',
  };
  delete env.ECS_DEPLOY_RENDERED_ENV_FILE;
  if (renderedFile) env.ECS_DEPLOY_RENDERED_ENV_FILE = renderedFile;
  const run = spawnSync(
    'bash',
    [script, 'dev', 'kortix/kortix-api:dev-new', '--version', '0.0.2-dev.new', '--dry-run'],
    { cwd: root, encoding: 'utf8', env },
  );
  return { ...run, dir };
}

describe('ecs-deploy.sh --dry-run rendered environment', () => {
  it('writes exactly the container environment the roll would register', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'ecs-render-out-')), 'task-env.json');
    const run = dryRun(file);
    expect(run.stderr).not.toContain('unhandled call');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('dry-run only');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual([
      // The running revision's values survive unless an override names them.
      { name: 'KEEP', value: 'from-the-running-revision' },
      // Overrides and the gateway target, sorted by name.
      { name: 'ADDED', value: 'by-override' },
      { name: 'KORTIX_PLATINUM_US_REGION', value: 'us-east' },
      { name: 'LLM_GATEWAY_PROXY_TARGET', value: 'https://gateway-dev-ecs-fargate.kortix.com' },
      // The version stamp replaces the old one; KORTIX_COMMIT is never carried.
      { name: 'KORTIX_VERSION', value: '0.0.2-dev.new' },
    ]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    // Secret values never reach the rendered environment.
    expect(readFileSync(file, 'utf8')).not.toContain('blob-value');
  });

  it('writes nothing when no file is requested', () => {
    const run = dryRun(null);
    expect(run.status).toBe(0);
    expect(existsSync(join(run.dir, 'task-env.json'))).toBe(false);
  });
});
