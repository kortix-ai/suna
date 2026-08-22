import { execFileSync } from 'node:child_process';
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
          { name: 'KORTIX_FAST_COLD_BOOT_ENABLED', value: 'false' },
        ],
        {
          KORTIX_FAST_COLD_BOOT_ENABLED: 'true',
          SECOND_FLAG: 'enabled',
        },
      ),
    ).toEqual([
      { name: 'KEEP', value: 'unchanged' },
      { name: 'KORTIX_FAST_COLD_BOOT_ENABLED', value: 'true' },
      { name: 'SECOND_FLAG', value: 'enabled' },
    ]);
  });

  it('rejects non-string override values', () => {
    expect(() =>
      mergeEnvironment([], { INVALID: 1 } as unknown as Record<string, string>),
    ).toThrow();
  });

  it('stages kpp2 off by default and requires an explicit full activation deploy', () => {
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
    const terraform = readFileSync(
      resolve(root, 'infra/terraform/environments/dev/variables.tf'),
      'utf8',
    );

    // Assert the KEY is staged off, not the exact serialization of the whole object.
    // Pinning the full JSON made this test fail the moment the preview work
    // added KORTIX_PREVIEW_BASE_DOMAIN alongside it — a correct config change
    // read as a regression. What this test is here to protect is that dev's API
    // task carries the explicit rollback value during rollout one. A manual
    // full deploy is the only path that can enable it after rollout checks.
    const overrides = apiDeploy.match(/KORTIX_ECS_ENV_OVERRIDES: >-\n\s+(\{.*\})/)?.[1];
    expect(overrides).toBeDefined();
    expect(JSON.parse(overrides!)).toMatchObject({
      KORTIX_FAST_COLD_BOOT_ENABLED:
        "${{ github.event_name == 'workflow_dispatch' && inputs.enable_fast_cold_boot && 'true' || 'false' }}",
    });
    expect(workflow).toContain('enable_fast_cold_boot:')
    const activationInput = workflow.slice(
      workflow.indexOf('enable_fast_cold_boot:'),
      workflow.indexOf('# Cancel a superseded deploy'),
    )
    expect(activationInput).toContain('default: false')
    expect(workflow).toContain("inputs.enable_fast_cold_boot && inputs.surface != 'all'")
    expect(workflow).toContain('Activation requires surface=all')
    const apiFilter = workflow.slice(
      workflow.indexOf('            api:'),
      workflow.indexOf('            gateway:'),
    );
    expect(apiFilter).toContain("- 'infra/scripts/ecs-deploy.sh'");
    expect(deployScript).toContain('--argjson environment "$MERGED_ENVIRONMENT_JSON"');
    expect(terraform).not.toContain('KORTIX_FAST_COLD_BOOT_ENABLED');
    const startupPrebuild = snapshotBuilder.slice(
      snapshotBuilder.indexOf('export function kickStartupPreBuild'),
      snapshotBuilder.indexOf('// ─── Custom (toml / UI) templates'),
    );
    expect(startupPrebuild).toContain('ensurePlatformDefaultImage');
    expect(startupPrebuild).not.toContain('ensureFastSandboxImage');
  });
});
