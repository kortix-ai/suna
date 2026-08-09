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
        'source "$1"; SERVICE_PREFIX=kortix-dev; SECRET_NAME=kortix-dev-env; configure_service_coordinates web; printf "%s|%s|%s|%s" "$CLUSTER" "$SERVICE" "$CONTAINER" "$SECRET_NAME"',
        'bash',
        script,
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, KORTIX_ECS_DEPLOY_LIB: '1' },
      },
    );

    expect(output).toBe('kortix-dev-web|kortix-dev-web|web|kortix-dev-web-env');
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
    expect(workflow).toContain('https://dev-web-ecs-fargate.kortix.com');
    expect(workflow).toContain('  publish-web-origin-dns:');
    expect(workflow).toContain('  verify-web-origin:');
    expect(workflow).toContain('  detach-web-dev-vercel-domain:');
    expect(workflow).toContain('  cutover-web-dev-dns:');
    expect(workflow).toContain('node infra/scripts/detach-vercel-web-domain.mjs dev');
    expect(workflow).toContain('node infra/scripts/sync-web-dns.mjs dev canonical "$alb"');
    expect(workflow).toContain('consecutive_matches=0');
    expect(workflow).toContain('/^x-vercel-/');
    expect(workflow).toContain('canonical DNS still targets Vercel');
    expect(workflow).toContain('gateway: ${{ steps.outputs.outputs.gateway }}');
    expect(workflow).toContain('cli: ${{ steps.outputs.outputs.cli }}');
    expect(workflow).toContain('gateway=false');
    expect(workflow).toContain('cli=false');
    expect(workflow).not.toContain('Vercel auto-deploys');
  });

  it('defines an isolated Dev web service and delays the canonical DNS cutover', () => {
    const terraform = read('infra/terraform/environments/dev-web/main.tf');
    const variables = read('infra/terraform/environments/dev-web/variables.tf');

    expect(terraform).toContain('data "aws_secretsmanager_secret" "web_env"');
    expect(terraform).toContain('module "web"');
    expect(terraform).toContain('container_name         = "web"');
    expect(terraform).toContain('health_check_path      = "/api/health"');
    expect(terraform).toContain('enable_postgres_egress = false');
    expect(terraform).toContain('var.manage_canonical_dns ?');
    expect(variables).toContain('variable "manage_canonical_dns"');
    expect(variables).toContain('default     = false');
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
