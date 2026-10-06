import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');

function mergeEnvironment(
  current: Array<{ name: string; value: string }>,
  overrides: Record<string, string>,
): Array<{ name: string; value: string }> {
  const output = execFileSync(
    'bash',
    [
      '-c',
      'source infra/scripts/ecs-deploy.sh; merge_environment_overrides "$CURRENT" "$OVERRIDES"',
    ],
    {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        KORTIX_ECS_DEPLOY_LIB: '1',
        CURRENT: JSON.stringify(current),
        OVERRIDES: JSON.stringify(overrides),
      },
    },
  );
  return JSON.parse(output);
}

describe('ECS task environment overrides', () => {
  it('replaces named values and preserves unrelated task environment', () => {
    expect(
      mergeEnvironment(
        [
          { name: 'KEEP', value: 'unchanged' },
          { name: 'KORTIX_EXAMPLE_FLAG', value: 'false' },
        ],
        {
          KORTIX_EXAMPLE_FLAG: 'true',
          SECOND_FLAG: 'enabled',
        },
      ),
    ).toEqual([
      { name: 'KEEP', value: 'unchanged' },
      { name: 'KORTIX_EXAMPLE_FLAG', value: 'true' },
      { name: 'SECOND_FLAG', value: 'enabled' },
    ]);
  });

  it('keeps Composio in dev and prod secret maps while retaining Pipedream for rollback', () => {
    for (const environment of ['dev', 'prod']) {
      const variables = readFileSync(
        resolve(root, `infra/terraform/environments/${environment}/variables.tf`),
        'utf8',
      );

      expect(variables).toContain('COMPOSIO_API_KEY');
      expect(variables).toContain('PIPEDREAM_CLIENT_ID');
      expect(variables).toContain('PIPEDREAM_CLIENT_SECRET');
      expect(variables).toContain('PIPEDREAM_PROJECT_ID');
    }

    const module = readFileSync(resolve(root, 'infra/terraform/modules/ecs-api/main.tf'), 'utf8');
    expect(module).toContain('{ name = "KORTIX_ENV_JSON", valueFrom = var.secrets_blob_arn }');
  });

  it('rejects non-string override values', () => {
    expect(() =>
      mergeEnvironment([], { INVALID: 1 } as unknown as Record<string, string>),
    ).toThrow();
  });

  it('maps every permanent API environment to its standalone gateway origin', () => {
    const targets = {
      dev: 'https://gateway-dev-ecs-fargate.kortix.com',
      staging: 'https://gateway-staging-ecs-fargate.kortix.com',
      prod: 'https://gateway-ecs-fargate.kortix.com',
      'prod-use2-shadow': 'https://gateway-use2-shadow.kortix.com',
      'dev-use2': 'https://gateway-dev-use2.kortix.com',
      'staging-euw2': 'https://gateway-staging-euw2.kortix.com',
    };
    const gatewayTarget = (environment: string) =>
      spawnSync(
        'bash',
        ['-c', 'source infra/scripts/ecs-deploy.sh; gateway_target_for_env "$1"', 'bash', environment],
        { cwd: root, encoding: 'utf8', env: { ...process.env, KORTIX_ECS_DEPLOY_LIB: '1' } },
      );
    for (const [environment, target] of Object.entries(targets)) {
      const result = gatewayTarget(environment);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(target);
    }
    expect(gatewayTarget('unknown').status).toBe(2);
  });

  it('places each environment in its region, its stack, and its secret', () => {
    const coordinates = (environment: string) =>
      spawnSync(
        'bash',
        [
          '-c',
          'source infra/scripts/ecs-deploy.sh; configure_env_coordinates "$1" && printf "%s %s %s" "$REGION" "$SERVICE_PREFIX" "$SECRET_NAME"',
          'bash',
          environment,
        ],
        { cwd: root, encoding: 'utf8', env: { ...process.env, KORTIX_ECS_DEPLOY_LIB: '1' } },
      );
    const expected = {
      dev: 'us-west-2 kortix-dev kortix-dev-env',
      staging: 'us-west-2 kortix-staging kortix-staging-env',
      prod: 'eu-west-2 kortix-prod kortix-prod-env',
      'prod-use2-shadow': 'us-east-2 kortix-prod-use2 kortix-prod-us-east-2-env',
      // The region-consolidation stacks keep the secret NAME and differ by region.
      'dev-use2': 'us-east-2 kortix-dev-use2 kortix-dev-env',
      'staging-euw2': 'eu-west-2 kortix-staging-euw2 kortix-staging-env',
    };
    for (const [environment, line] of Object.entries(expected)) {
      const result = coordinates(environment);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(line);
    }
    expect(coordinates('unknown').status).toBe(2);
  });

  it('carries no fast cold boot activation path', () => {
    const workflow = readFileSync(resolve(root, '.github/workflows/deploy-dev.yml'), 'utf8');
    const deployScript = readFileSync(resolve(root, 'infra/scripts/ecs-deploy.sh'), 'utf8');
    const snapshotBuilder = readFileSync(
      resolve(root, 'apps/api/src/snapshots/builder.ts'),
      'utf8',
    );
    const apiDeploy = workflow.slice(
      workflow.indexOf('  deploy-api-ecs:'),
      workflow.indexOf('  deploy-apps-router:'),
    );

    // The experiment is gone: no dispatch input, no override key, no Platinum
    // capability probe in the deploy script.
    const overrides = apiDeploy.match(/KORTIX_ECS_ENV_OVERRIDES: >-\n\s+(\{.*\})/)?.[1];
    expect(overrides).toBeDefined();
    expect(JSON.parse(overrides!)).not.toHaveProperty('KORTIX_FAST_COLD_BOOT_ENABLED');
    expect(workflow).not.toContain('enable_fast_cold_boot');
    expect(deployScript).not.toContain('KORTIX_FAST_COLD_BOOT_ENABLED');
    expect(deployScript).not.toContain('atomic_admission');

    const apiFilter = workflow.slice(
      workflow.indexOf('            api:'),
      workflow.indexOf('            gateway:'),
    );
    expect(apiFilter).toContain("- 'infra/scripts/ecs-deploy.sh'");
    expect(deployScript).toContain('--argjson environment "$MERGED_ENVIRONMENT_JSON"');
    const startupPrebuild = snapshotBuilder.slice(
      snapshotBuilder.indexOf('export function kickStartupPreBuild'),
      snapshotBuilder.indexOf('// ─── Custom (toml / UI) templates'),
    );
    expect(startupPrebuild).toContain('ensurePlatformDefaultImage');
  });
});
