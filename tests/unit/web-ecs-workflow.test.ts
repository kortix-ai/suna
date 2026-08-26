import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');

function read(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), 'utf8');
}

describe('web ECS migration', () => {
  it('maps --service web to the dedicated cluster, container, and secret', () => {
    const output = execFileSync(
      'bash',
      [
        '-c',
        'source infra/scripts/ecs-deploy.sh; SERVICE_PREFIX=kortix-dev; SECRET_NAME=kortix-dev-env; configure_service_coordinates web; printf "%s|%s|%s|%s|%s" "$CLUSTER" "$SERVICE" "$CONTAINER" "$SECRET_NAME" "$VERSION_ENV_NAME"',
      ],
      {
        cwd: root,
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
    expect(workflow).toContain('base=https://dev.kortix.com');
    expect(workflow).toContain('  publish-web-ecs-dns:');
    const webDnsStart = workflow.indexOf('  publish-web-ecs-dns:');
    const webDns = workflow.slice(webDnsStart, webVerifyStart);
    expect(webDns).toContain('if: ${{ always()');
    expect(webDns).toContain("needs.deploy-web-ecs.result == 'success'");
    const webVerify = workflow.slice(
      webVerifyStart,
      workflow.indexOf('  promote-dev-channel-frontend:'),
    );
    expect(webVerify).toContain('if: ${{ always()');
    expect(webVerify).toContain("needs.publish-web-ecs-dns.result == 'success'");
    expect(workflow).toContain('node infra/scripts/sync-web-dns.mjs dev "$alb"');
    expect(workflow).not.toContain('detach-web-dev-vercel-domain');
    expect(workflow).not.toContain('detach-vercel-web-domain.mjs');
    expect(workflow).toContain('consecutive_matches=0');
    expect(workflow).toContain('/^x-vercel-/');
    expect(workflow).toContain('kortix:${WEB_PROTECTION_PASSWORD}x');
    expect(workflow).toContain('cookie_only=');
    expect(workflow).toContain('[ "$vercel_headers" = 0 ]');
    expect(workflow).not.toContain('dev-fe-ecs.kortix.com');
    expect(workflow).toContain('gateway: ${{ steps.outputs.outputs.gateway }}');
    expect(workflow).toContain('cli: ${{ steps.outputs.outputs.cli }}');
    expect(workflow).toContain('gateway=false');
    expect(workflow).toContain('cli=false');
    expect(workflow).toContain('Vercel is disabled for main');
  });

  it('defines the Dev web service and canonical DNS record', () => {
    const terraform = read('infra/terraform/environments/dev-web/main.tf');
    const variables = read('infra/terraform/environments/dev-web/variables.tf');

    expect(terraform).toContain('data "aws_secretsmanager_secret" "web_env"');
    expect(terraform).toContain('module "web"');
    expect(terraform).toContain('container_name         = "web"');
    expect(terraform).toContain('health_check_path      = "/api/health"');
    expect(terraform).toContain('enable_postgres_egress = false');
    expect(terraform).toContain('name    = "dev"');
    expect(terraform).not.toContain('dev-fe-ecs');
    expect(variables).toContain('Manage the canonical dev.kortix.com CNAME');
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

  it('builds preview images without credentials and deploys one full self-host sandbox', () => {
    const workflow = read('.github/workflows/deploy-preview.yml');
    const buildJobs = workflow.slice(
      workflow.indexOf('  build-api:'),
      workflow.indexOf('  deploy:'),
    );

    expect(buildJobs.match(/persist-credentials: false/g)).toHaveLength(3);
    expect(buildJobs.match(/push: false/g)).toHaveLength(3);
    expect(buildJobs.match(/platforms: linux\/amd64/g)).toHaveLength(3);
    expect(workflow).toContain("github.event.action == 'labeled'");
    expect(workflow).toContain("github.event.action == 'synchronize'");
    expect(workflow).toContain('labels/preview');
    expect(workflow).toContain('bun tests/bin/sandbox-preview.ts deploy');
    expect(workflow).toContain('bun tests/bin/sandbox-preview.ts teardown');
    expect(workflow).toContain('bun tests/bin/sandbox-preview.ts reconcile');
    expect(workflow.match(/uses: oven-sh\/setup-bun@v2/g)).toHaveLength(3);
    expect(workflow).toContain('pnpm test -- --target-full');
    expect(workflow).toContain('PREVIEW_LOCKFILE_SHA256');
    expect(workflow).toContain('Test report:');
    expect(workflow).toContain('deployments: write');
    expect(workflow).toContain('type: choice');
    expect(workflow).toContain('- platinum');
    expect(workflow).toContain('- daytona');
    expect(workflow).not.toContain('infra/scripts/ecs-preview.sh');
    expect(workflow).not.toContain('configure-aws-credentials');
    expect(workflow).not.toMatch(/vercel/i);
    expect(workflow).not.toContain('KORTIX_PREVIEW_APPROVED_SHA');
    expect(workflow).toContain('**Preview:**');
  });

  it('disables Vercel auto-deploys everywhere except staging', () => {
    const config = read('apps/web/vercel.json');
    const ignore = read('apps/web/scripts/vercel-ignore.sh');

    expect(config).toContain('"main": false');
    expect(config).toContain('"staging": true');
    // prod must NOT auto-deploy on push: during the 2026-08-10 v0.12.7 rollout
    // the auto-deployed new frontend called routes the still-old API lacked
    // and every project load failed. kortix.com deploys only from
    // deploy-prod.yml's deploy-web-vercel job, after verify-live-version.
    expect(config).toContain('"prod": false');
    expect(ignore).toContain('prod deploys only via deploy-prod.yml');
    expect(ignore).not.toContain('KORTIX_PREVIEW_APPROVED_SHA');
    expect(ignore).not.toContain('*:main');
    expect(ignore).toContain('dev deploys on ECS; PR previews deploy in sandboxes');
  });

  it('deploys the prod Vercel frontend only after the API serves the release', () => {
    const workflow = read('.github/workflows/deploy-prod.yml');
    expect(workflow).toContain('deploy-web-vercel:');
    expect(workflow).toMatch(
      /deploy-web-vercel:\s*\n\s*name:[^\n]*\n\s*needs: \[version, verify-live-version\]/,
    );
    expect(workflow).toContain('prj_SoUUSNJPvOTDneE0E7faWHFuWMAY');
    expect(workflow).toContain(
      '--env "KORTIX_PUBLIC_VERSION=${{ needs.version.outputs.version }}"',
    );
    expect(workflow).not.toContain('env add NEXT_PUBLIC_KORTIX_VERSION production');
    expect(workflow).not.toContain('env rm NEXT_PUBLIC_KORTIX_VERSION production');
    expect(workflow).toMatch(
      /frontend-auth-proof:\s*\n\s*name:[^\n]*\n\s*needs: \[[^\]]*deploy-web-vercel\]/,
    );
  });

  it('refuses to publish a release through a tag that points at another commit', () => {
    const workflow = read('.github/workflows/deploy-prod.yml');
    expect(workflow).toContain('refs/tags/v$V^{commit}');
    expect(workflow).toContain('[ "$EXISTING" != "$GITHUB_SHA" ]');
    expect(workflow).toContain('Refusing to reuse or move an immutable release tag.');
    expect(workflow).toContain('target_commitish: ${{ github.sha }}');
  });

  it('carries both Basic auth credentials and the Vercel SSO bypass in QA', () => {
    const config = read('tests/playwright.config.ts');
    expect(config).toContain('WEB_PROTECTION_PASSWORD');
    expect(config).toContain("username: 'kortix'");
    // Two different protections guard two different deployed targets, so the
    // config carries both. Basic auth covers password-protected environments.
    // Staging/preview use Vercel SSO protection instead, which httpCredentials
    // cannot satisfy — only the bypass secret gets past it.
    expect(config).toContain('deploymentBypassSecret()');
    expect(config).toContain('storageState: vercelBypass ? DEPLOYMENT_BYPASS_STATE_PATH');
    expect(existsSync(resolve(root, 'tests/visual/playwright.config.ts'))).toBe(false);
    expect(existsSync(resolve(root, 'tests/accessibility/playwright.config.ts'))).toBe(false);
    expect(existsSync(resolve(root, 'tests/e2e/examples/playwright.config.ts'))).toBe(false);
  });

  it('the deployment-bypass storage state is never written under an uploaded artifact path', () => {
    // tests/test-results/** is uploaded verbatim on a public repo; the state
    // file holds the live _vercel_jwt cookie. Both guards must hold: the file
    // lives outside test-results, AND every upload of test-results excludes
    // it by name (belt and braces — see deployment-bypass.ts).
    const helper = read('tests/e2e/helpers/deployment-bypass.ts');
    expect(helper).not.toMatch(/'test-results',\s*\n\s*'deployment-bypass-state\.json'/);
    expect(helper).toContain("'.state',");
    expect(read('tests/.gitignore')).toContain('.state/');
    for (const wf of [
      '.github/workflows/tests-release.yml',
      '.github/workflows/tests-browser-nightly.yml',
      '.github/workflows/tests.yml',
      '.github/workflows/deploy-preview.yml',
    ]) {
      const uploads = read(wf).split('upload-artifact@').slice(1);
      let seen = 0;
      for (const block of uploads) {
        const head = block.slice(0, 600);
        if (!head.includes('tests/test-results/**')) continue;
        seen += 1;
        expect(head, wf).toContain('!tests/test-results/deployment-bypass-state.json');
      }
      expect(seen, wf).toBeGreaterThan(0);
    }
  });

  /**
   * The bypass secret must never ride on `use.extraHTTPHeaders`.
   *
   * Chromium applies those headers to EVERY request the context makes, so the
   * release gate sent `x-vercel-protection-bypass` to 16 hosts — including
   * googletagmanager.com, connect.facebook.net and doubleclick.net — and, worse
   * for the gate, attached it to cross-origin XHR against staging-api. That put
   * the two header names into `Access-Control-Request-Headers`, which the API's
   * fixed `Access-Control-Allow-Headers` list (apps/api/src/middleware/cors.ts)
   * does not contain, so Chromium killed every browser API call with
   * `net::ERR_FAILED`. Nine of the eleven specs red in release runs
   * 32306385663 and 32310893789 died that way. The bypass is a cookie now.
   */
  it('never broadcasts the Vercel bypass secret as a blanket request header', () => {
    const config = read('tests/playwright.config.ts');
    expect(config).not.toContain('extraHTTPHeaders:');
    expect(config).not.toContain("'x-vercel-protection-bypass':");
    const helper = read('tests/e2e/helpers/deployment-bypass.ts');
    // The header is sent exactly once, to the origin that issues the cookie.
    expect(helper).toContain("'x-vercel-protection-bypass': secret");
    expect(helper).toContain('_vercel_jwt');
    // A plain clearCookies() drops the bypass cookie and 302s the next
    // navigation to vercel.com/sso-api, so the app-session resets go through
    // the preserving helper instead.
    expect(read('tests/e2e/helpers/session-auth.ts')).toContain('clearCookiesPreservingBypass');
    expect(read('tests/e2e/specs/01-account-auth.spec.ts')).toContain(
      'clearCookiesPreservingBypass',
    );
  });
});
