import { execFileSync, spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT as root, readRepoFile, readWorkflow } from '../src/fixtures/repo';

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

  it('keeps Composio in the prod secret map while retaining Pipedream for rollback', () => {
    const variables = readRepoFile('infra/terraform/environments/prod/variables.tf');

    expect(variables).toContain('COMPOSIO_API_KEY');
    expect(variables).toContain('PIPEDREAM_CLIENT_ID');
    expect(variables).toContain('PIPEDREAM_CLIENT_SECRET');
    expect(variables).toContain('PIPEDREAM_PROJECT_ID');

    const module = readRepoFile('infra/terraform/modules/ecs-api/main.tf');
    expect(module).toContain('{ name = "KORTIX_ENV_JSON", valueFrom = var.secrets_blob_arn }');
  });

  it('rejects non-string override values', () => {
    expect(() =>
      mergeEnvironment([], { INVALID: 1 } as unknown as Record<string, string>),
    ).toThrow();
  });

  it('maps every permanent API environment to its standalone gateway origin', () => {
    const targets = {
      prod: 'https://gateway-ecs-fargate.kortix.com',
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
    // The us-west-2 targets were destroyed on 2026-10-12.
    expect(gatewayTarget('dev').status).toBe(2);
    expect(gatewayTarget('staging').status).toBe(2);
    // The us-east-2 prod shadow was removed on 2026-10-12.
    expect(gatewayTarget('prod-use2-shadow').status).toBe(2);
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
      prod: 'eu-west-2 kortix-prod kortix-prod-env',
      // The dev and staging stacks keep the environment's secret NAME.
      'dev-use2': 'us-east-2 kortix-dev-use2 kortix-dev-env',
      'staging-euw2': 'eu-west-2 kortix-staging-euw2 kortix-staging-env',
    };
    for (const [environment, line] of Object.entries(expected)) {
      const result = coordinates(environment);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(line);
    }
    expect(coordinates('unknown').status).toBe(2);
    expect(coordinates('dev').status).toBe(2);
    expect(coordinates('staging').status).toBe(2);
  });

  it('carries no fast cold boot activation path', () => {
    const workflow = readWorkflow('deploy-dev.yml');
    const deployScript = readRepoFile('infra/scripts/ecs-deploy.sh');
    const snapshotBuilder = readRepoFile('apps/api/src/snapshots/builder.ts');
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
