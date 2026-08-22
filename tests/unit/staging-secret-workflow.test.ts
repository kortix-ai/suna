import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('staging secret synchronization', () => {
  it('assumes the staging deploy role before reading or updating the secret bundle', () => {
    const workflow = readFileSync(
      resolve(import.meta.dirname, '../../.github/workflows/deploy-staging.yml'),
      'utf8',
    );
    const syncSecretStart = workflow.indexOf('  sync-secret:');
    const deployStart = workflow.indexOf('  deploy-ecs:');
    const syncSecretJob = workflow.slice(syncSecretStart, deployStart);

    expect(syncSecretStart).toBeGreaterThan(-1);
    expect(deployStart).toBeGreaterThan(syncSecretStart);
    expect(syncSecretJob).toContain('ROLE: arn:aws:iam::935064898258:role/kortix-gha-ecs-deploy');
    expect(syncSecretJob).toContain('role-to-assume: ${{ env.ROLE }}');
  });

  it('grants the deploy role write access only to the staging secret bundle', () => {
    const policy = readFileSync(
      resolve(import.meta.dirname, '../../infra/terraform/security-baseline/iam-gha-ecs-deploy.tf'),
      'utf8',
    );
    const secretsPolicyStart = policy.indexOf(
      'resource "aws_iam_role_policy" "gha_ecs_deploy_secrets"',
    );
    const importsStart = policy.indexOf('# ── One-shot adoption', secretsPolicyStart);
    const secretsPolicy = policy.slice(secretsPolicyStart, importsStart);
    const readStart = secretsPolicy.indexOf('Sid    = "ReadKortixEnvironmentSecrets"');
    const writeStart = secretsPolicy.indexOf('Sid    = "WriteStagingSecret"');
    const readStatement = secretsPolicy.slice(readStart, writeStart);
    const writeStatement = secretsPolicy.slice(writeStart);

    expect(secretsPolicyStart).toBeGreaterThan(-1);
    expect(importsStart).toBeGreaterThan(secretsPolicyStart);
    expect(readStart).toBeGreaterThan(-1);
    expect(writeStart).toBeGreaterThan(readStart);
    expect(readStatement).not.toContain('secretsmanager:PutSecretValue');
    expect(readStatement).not.toContain('secretsmanager:CreateSecret');
    expect(writeStatement).toContain('secretsmanager:PutSecretValue');
    expect(writeStatement).toContain('secretsmanager:CreateSecret');
    expect(writeStatement).toContain(
      'Resource = "arn:aws:secretsmanager:us-west-2:${local.account_id}:secret:kortix-staging-env-*"',
    );
  });

  it('preserves the existing staging bundle and uses dev only for first creation', () => {
    const workflow = readFileSync(
      resolve(import.meta.dirname, '../../.github/workflows/deploy-staging.yml'),
      'utf8',
    );

    const preserveStart = workflow.indexOf(
      'if aws secretsmanager describe-secret --secret-id kortix-staging-env',
    );
    const payloadStart = workflow.indexOf('payload="$(jq -cn');
    const preservationBlock = workflow.slice(preserveStart, payloadStart);

    expect(preserveStart).toBeGreaterThan(-1);
    expect(payloadStart).toBeGreaterThan(preserveStart);
    expect(preservationBlock).toContain('--secret-id kortix-staging-env');
    expect(preservationBlock).toContain('staging_secret_exists=true');
    expect(preservationBlock).toContain('else');
    expect(preservationBlock).toContain('--secret-id kortix-dev-env');
    expect(preservationBlock).toContain('staging_secret_exists=false');
    expect(workflow).toContain('if [ "$staging_secret_exists" = true ]; then');
  });

  it('caps the staging ECS API database pool below the 60-connection database limit', () => {
    const workflow = readFileSync(
      resolve(import.meta.dirname, '../../.github/workflows/deploy-staging.yml'),
      'utf8',
    );
    expect(workflow).toContain('DB_POOL_MAX: "4"');
  });
});
