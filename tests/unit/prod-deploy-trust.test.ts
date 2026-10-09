import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repo = resolve(import.meta.dirname, '../..');
const read = (p: string) => readFileSync(resolve(repo, p), 'utf8');
const PROD_ROLE = 'role/kortix-gha-ecs-deploy-prod';

/** Split a workflow into its top-level jobs: name -> raw text. */
function jobsOf(yaml: string): Map<string, string> {
  const start = yaml.search(/^jobs:\s*$/m);
  const body = yaml.slice(start).split('\n').slice(1).join('\n');
  const out = new Map<string, string>();
  const parts = body.split(/^  ([a-z0-9-]+):\s*$/m);
  for (let i = 1; i < parts.length; i += 2) out.set(parts[i], parts[i + 1]);
  return out;
}

describe('prod deploy trust', () => {
  it('the prod role trusts only the prod GitHub environment', () => {
    const tf = read('infra/terraform/security-baseline/iam-gha-ecs-deploy.tf');
    const block = tf.slice(tf.indexOf('resource "aws_iam_role" "gha_ecs_deploy_prod"'));
    const trust = block.slice(0, block.indexOf('tags = {'));
    expect(trust).toContain('"repo:kortix-ai/suna:environment:prod"');
    expect(trust).not.toContain('StringLike');
    expect(trust).not.toContain('suna:*');
  });

  it.each(['.github/workflows/deploy-prod.yml', '.github/workflows/deploy-prod-us-east-2-shadow.yml'])(
    '%s: every job that uses the prod role declares `environment: prod`',
    (file) => {
      const jobs = jobsOf(read(file));
      const usingRole = [...jobs].filter(([, text]) => text.includes(PROD_ROLE));
      expect(usingRole.length).toBeGreaterThan(0);
      for (const [name, text] of usingRole) {
        expect(text, `${file} job ${name}`).toMatch(/^ {4}environment: prod\s*$/m);
      }
    },
  );

  it('deploy-prod: the migrate job reads the prod blob through the prod role under environment prod', () => {
    const migrate = jobsOf(read('.github/workflows/deploy-prod.yml')).get('migrate-db')!;
    expect(migrate).toMatch(/^ {4}environment: prod\s*$/m);
    expect(migrate).toContain(`role-to-assume: arn:aws:iam::935064898258:${PROD_ROLE}`);
  });

  it('deploy-prod: the version job refuses any ref except prod before it publishes', () => {
    const version = jobsOf(read('.github/workflows/deploy-prod.yml')).get('version')!;
    expect(version.indexOf('refs/heads/prod')).toBeGreaterThan(-1);
    expect(version.indexOf('refs/heads/prod')).toBeLessThan(version.indexOf('actions/checkout'));
  });

  it('deploy-prod: no job claims a prod schema gate that does not exist', () => {
    const deploy = read('.github/workflows/deploy-prod.yml');
    expect(deploy).not.toMatch(/^ {2}verify-schema:/m);
    expect(deploy).not.toContain('ENABLE_PROD_SCHEMA_GATE');
  });

  it('deploy-prod: retag accepts a staging image only', () => {
    const deploy = read('.github/workflows/deploy-prod.yml');
    expect(deploy).not.toContain('DEV_TAG');
  });
});

describe('promote green gate', () => {
  const promote = read('.github/workflows/promote.yml');
  it('fails closed: no `|| true` on the check-runs call, and the manifest checks are required', () => {
    const gate = promote.slice(promote.indexOf('check_green() {'), promote.indexOf('check_green "$IMAGE_SHA"'));
    expect(gate).not.toContain('|| true');
    expect(gate).toContain('gh api failed');
    for (const name of ['API', 'gateway', 'frontend']) {
      expect(gate).toContain(`Publish ${name} manifest (staging)`);
    }
  });
});

describe('ecs-scale', () => {
  it('passes inputs through env, never through `${{ inputs.* }}` inside a run block', () => {
    const wf = read('.github/workflows/ecs-scale.yml');
    const runBlocks = wf.split(/^\s+run: \|$/m).slice(1).map((b) => b.split(/^\s{6}- /m)[0]);
    for (const block of runBlocks) expect(block).not.toContain('${{');
  });
});

describe('prod access is reachable only through the prod role (phase 2)', () => {
  it('the broad repo:* role holds no prod ECS, PassRole, or secret grant', () => {
    const tf = read('infra/terraform/security-baseline/iam-gha-ecs-deploy.tf');
    const broad = tf
      .slice(0, tf.indexOf('# ── kortix-gha-ecs-deploy-prod'))
      .split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .join('\n');
    expect(broad).not.toMatch(/kortix-prod/);
    expect(broad).not.toContain('kortix-*-env-*');
    expect(broad).not.toContain('service/kortix-*/kortix-*');
  });

  it('every workflow job that touches a prod blob or prod ECS declares `environment: prod`', () => {
    const dir = resolve(repo, '.github/workflows');
    const offenders: string[] = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.yml'))) {
      for (const [name, text] of jobsOf(readFileSync(resolve(dir, file), 'utf8'))) {
        const code = text.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
        const touchesProd = /kortix-prod-env|kortix-prod-web-env|ecs-deploy\.sh\s+prod|ecs-deploy\.sh\s+\\\s*\n\s*prod\b/.test(code);
        const ownRole = code.includes('kortix-gha-prod-use2-terraform');
        if (touchesProd && !ownRole && !/^ {4}environment: prod\s*$/m.test(code)) offenders.push(`${file}:${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
