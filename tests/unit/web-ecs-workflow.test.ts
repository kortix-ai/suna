import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');

function read(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), 'utf8');
}

describe('web ECS migration', () => {
  it('maps --service web to the dedicated cluster, container, and secret', () => {
    const script = resolve(root, 'infra/scripts/ecs-deploy.sh');
    const output = execFileSync(
      'bash',
      [
        '-c',
        'source "$1"; SERVICE_PREFIX=kortix-dev; SECRET_NAME=kortix-dev-env; configure_service_coordinates web; printf "%s|%s|%s|%s|%s" "$CLUSTER" "$SERVICE" "$CONTAINER" "$SECRET_NAME" "$VERSION_ENV_NAME"',
        'bash',
        script,
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, KORTIX_ECS_DEPLOY_LIB: '1' },
      },
    );

    expect(output).toBe(
      'kortix-dev-web|kortix-dev-web|web|kortix-dev-web-env|KORTIX_PUBLIC_VERSION',
    );
  });

  it('deploys the immutable frontend image and encrypted Dev profile to ECS', () => {
    const workflow = read('.github/workflows/deploy-dev.yml');
    const webDeployStart = workflow.indexOf('  deploy-web-ecs:');
    const webVerifyStart = workflow.indexOf('  verify-web-dev:');
    const webDeploy = workflow.slice(webDeployStart, webVerifyStart);

    expect(webDeployStart).toBeGreaterThan(-1);
    expect(webVerifyStart).toBeGreaterThan(webDeployStart);
    expect(workflow).toContain('NEXT_PUBLIC_KORTIX_COMMIT: ${{ github.sha }}');
    expect(webDeploy).toContain('WEB_DOTENV_PRIVATE_KEY_DEV');
    expect(webDeploy).toContain('bash infra/scripts/sync-web-env.sh dev');
    expect(webDeploy).toContain('--service web');
    expect(webDeploy).toContain('${{ needs.build-frontend.outputs.image }}');
    expect(workflow).toContain('https://dev-fe-ecs.kortix.com');
    expect(workflow).toContain('  publish-web-ecs-dns:');
    expect(workflow).toContain('node infra/scripts/sync-web-dns.mjs dev "$alb"');
    expect(workflow).not.toContain('detach-web-dev-vercel-domain');
    expect(workflow).not.toContain('cutover-web-dev-dns');
    expect(workflow).not.toContain('detach-vercel-web-domain.mjs');
    expect(workflow).not.toContain('sync-web-dns.mjs dev canonical');
    expect(workflow).toContain('consecutive_matches=0');
    expect(workflow).toContain('/^x-vercel-/');
    expect(workflow).toContain('dev.kortix.com remained on Vercel');
    expect(workflow).toContain('gateway: ${{ steps.outputs.outputs.gateway }}');
    expect(workflow).toContain('cli: ${{ steps.outputs.outputs.cli }}');
    expect(workflow).toContain('gateway=false');
    expect(workflow).toContain('cli=false');
    expect(workflow).toContain('dev.kortix.com stays on Vercel');
  });

  it('defines an isolated Dev web service that cannot manage canonical DNS', () => {
    const terraform = read('infra/terraform/environments/dev-web/main.tf');
    const variables = read('infra/terraform/environments/dev-web/variables.tf');

    expect(terraform).toContain('data "aws_secretsmanager_secret" "web_env"');
    expect(terraform).toContain('module "web"');
    expect(terraform).toContain('container_name         = "web"');
    expect(terraform).toContain('health_check_path      = "/api/health"');
    expect(terraform).toContain('enable_postgres_egress = false');
    expect(terraform).toContain('dev-fe-ecs');
    expect(terraform).not.toContain('name    = "dev"');
    expect(variables).toContain('This stack never manages dev.kortix.com');
    expect(variables).not.toContain('manage_canonical_dns');
  });

  it('defines isolated staging and production services with environment-specific capacity', () => {
    const staging = read('infra/terraform/environments/staging-web/main.tf');
    const stagingVariables = read('infra/terraform/environments/staging-web/variables.tf');
    const prod = read('infra/terraform/environments/prod-web/main.tf');
    const prodVariables = read('infra/terraform/environments/prod-web/variables.tf');

    expect(staging).toContain('name = "kortix-staging-web"');
    expect(staging).toContain('name = "kortix-staging-web-env"');
    expect(staging).toContain('staging-fe-ecs');
    expect(staging).toContain('min_capacity     = 1');
    expect(staging).toContain('max_capacity     = 4');
    expect(stagingVariables).toContain('never manages staging.kortix.com');

    expect(prod).toContain('name = "kortix-prod-web"');
    expect(prod).toContain('name = "kortix-prod-web-env"');
    expect(prod).toContain('prod-fe-ecs');
    expect(prod).toContain('min_capacity     = 2');
    expect(prod).toContain('max_capacity     = 12');
    expect(prod).toContain('use_fargate_spot = false');
    expect(prodVariables).toContain('never manages kortix.com');
  });

  it('deploys staging and production ECS frontends without replacing canonical Vercel hosts', () => {
    const staging = read('.github/workflows/deploy-staging.yml');
    const prod = read('.github/workflows/deploy-prod.yml');
    const rollback = read('.github/workflows/rollback-prod.yml');

    expect(staging).toContain('  deploy-web-ecs:');
    expect(staging).toContain('bash infra/scripts/sync-web-env.sh staging');
    expect(staging).toContain('kortix/kortix-frontend:staging-${SHA8}');
    expect(staging).toContain('node infra/scripts/sync-web-dns.mjs staging "$alb"');
    expect(staging).toContain('https://${ECS_WEB_HOST}');
    expect(staging).toContain('Deploy staging web to Vercel');

    expect(prod).toContain('  deploy-web-ecs:');
    expect(prod).toContain('bash infra/scripts/sync-web-env.sh prod');
    expect(prod).toContain('node infra/scripts/sync-web-dns.mjs prod "$alb"');
    expect(prod).toContain('https://prod-fe-ecs.kortix.com');
    expect(prod).toContain('https://kortix.com/api/runtime-config');
    expect(rollback).toContain('kortix/kortix-frontend:${TARGET}');
    expect(rollback).toContain('--service web');
    expect(rollback).toContain('kortix/kortix-api:${TARGET}');
    expect(rollback).toContain('kortix/kortix-gateway:${TARGET}');
    expect(rollback).toContain('--service gateway');
    expect(rollback).not.toContain('infra/k8s');
    expect(rollback).not.toContain('Argo CD');
  });

  it('contains no active Kubernetes deployment paths', () => {
    for (const file of [
      '.github/workflows/deploy-dev.yml',
      '.github/workflows/deploy-staging.yml',
      '.github/workflows/deploy-prod.yml',
      '.github/workflows/deploy-preview.yml',
      '.github/workflows/promote.yml',
      '.github/workflows/rollback-prod.yml',
    ]) {
      const workflow = read(file);
      expect(workflow).not.toContain('infra/k8s');
      expect(workflow).not.toContain('Argo CD');
      expect(workflow).not.toContain('ops.kortix.com');
    }
  });

  it('uses Basic auth credentials in QA instead of Vercel bypass headers', () => {
    for (const file of [
      'tests/playwright.config.ts',
      'tests/visual/playwright.config.ts',
      'tests/accessibility/playwright.config.ts',
      'tests/e2e/examples/playwright.config.ts',
    ]) {
      const config = read(file);
      expect(config).toContain('WEB_PROTECTION_PASSWORD');
      expect(config).toContain("username: 'kortix'");
      expect(config).not.toContain('x-vercel-protection-bypass');
    }
  });
});
