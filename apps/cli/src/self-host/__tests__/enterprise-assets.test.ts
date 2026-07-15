import { describe, expect, test } from 'bun:test';
import { dirname, join, normalize } from 'node:path/posix';

import {
  enterpriseTerraformAssets,
  LOCAL_STATE_BACKEND,
  REMOTE_STATE_BACKEND,
} from '../enterprise-assets.ts';

describe('embedded enterprise Terraform graph', () => {
  test('contains every transitive local module referenced by a bundled root or module', () => {
    const paths = Object.keys(enterpriseTerraformAssets);
    const missing: string[] = [];

    for (const [path, content] of Object.entries(enterpriseTerraformAssets)) {
      for (const match of content.matchAll(/^\s*source\s*=\s*"(\.[^"]+)"/gm)) {
        const target = normalize(join(dirname(path), match[1]));
        if (!paths.some((candidate) => candidate.startsWith(`${target}/`))) {
          missing.push(`${path} -> ${match[1]} (${target})`);
        }
      }
    }

    expect(missing).toEqual([]);
  });

  test('does not bundle Terraform runtime state or provider binaries', () => {
    const paths = Object.keys(enterpriseTerraformAssets);
    expect(paths.some((path) => path.includes('/.terraform/'))).toBe(false);
    expect(paths.some((path) => path.endsWith('.tfstate'))).toBe(false);
    expect(paths.some((path) => path.includes('terraform-provider-'))).toBe(false);
  });

  test('ships explicit local-bootstrap and customer-S3 backend modes', () => {
    expect(LOCAL_STATE_BACKEND).toContain('backend "local"');
    expect(LOCAL_STATE_BACKEND).toContain('terraform.bootstrap.tfstate');
    expect(REMOTE_STATE_BACKEND).toContain('backend "s3"');
    expect(REMOTE_STATE_BACKEND).not.toContain('bucket');
  });

  test('is a 100% Docker appliance graph: no EKS/Helm and no ECS/ALB/ACM/deployer module', () => {
    const paths = Object.keys(enterpriseTerraformAssets);
    expect(paths.some((path) => path.startsWith('modules/eks/'))).toBe(false);
    expect(paths.some((path) => path.startsWith('modules/enterprise-platform/'))).toBe(false);
    // The appliance runs everything as Docker on the Supabase EC2 — Caddy owns
    // TLS + routing, so ECS/ALB/ACM/deployer Terraform is gone.
    for (const gone of ['acm.tf', 'alb.tf', 'ecs.tf', 'deployer.tf']) {
      expect(paths.some((path) => path === `modules/enterprise-vpc/${gone}`)).toBe(false);
    }
    // The Supabase EC2 is now the whole appliance host.
    expect(paths).toContain('modules/enterprise-vpc/supabase.tf');
  });

  test('allows CloudTrail to publish through the customer KMS-encrypted alert topic', () => {
    const kms = enterpriseTerraformAssets['modules/enterprise-vpc/kms.tf'];
    const cloudTrail = kms.slice(
      kms.indexOf('sid = "CloudTrailEncryption"'),
      kms.indexOf('sid = "CloudWatchLogsEncryption"'),
    );
    expect(cloudTrail).toContain('"kms:Decrypt"');
    expect(cloudTrail).toContain('"kms:GenerateDataKey*"');
    expect(cloudTrail).toContain('identifiers = ["cloudtrail.amazonaws.com"]');
    expect(cloudTrail).toContain('variable = "aws:SourceArn"');
  });

  test('installs a pinned AWS CLI distribution supported by the AL2023 Supabase host', () => {
    const userData = enterpriseTerraformAssets['modules/enterprise-vpc/files/supabase-user-data.sh.tftpl'];

    expect(userData).not.toContain('dnf install -y amazon-cloudwatch-agent awscli2');
    expect(userData).toContain('dnf install -y amazon-cloudwatch-agent docker jq unzip xfsprogs');
    expect(userData).not.toContain('dnf install -y amazon-cloudwatch-agent curl');
    expect(userData).toContain('awscli-exe-linux-x86_64-2.25.14.zip');
    expect(userData).toContain('9145327c1e33e5df50ad9a283fd1cb47e256f858c0a846017c11bc2eab8e47f1');
    expect(userData).toContain('aws --version');
  });

  test('allows the Supabase stack enough time for its graceful Compose shutdown', () => {
    const userData = enterpriseTerraformAssets['modules/enterprise-vpc/files/supabase-user-data.sh.tftpl'];

    expect(userData).toContain('TimeoutStartSec=1800');
    expect(userData).toContain('TimeoutStopSec=300');
  });

  test('allows SSM managed instances to use both command transport services through the workload boundary', () => {
    const state = enterpriseTerraformAssets['modules/enterprise-state/main.tf'];
    const boundary = state.slice(
      state.indexOf('sid    = "BoundRuntimeIdentityPolicies"'),
      state.indexOf('sid    = "DenyIdentityAndKeyEscalation"'),
    );

    expect(boundary).toContain('"ssm:*"');
    expect(boundary).toContain('"ssmmessages:*"');
    expect(boundary).toContain('"ec2messages:*"');
  });

  test('the appliance runs the app tier as Docker on the box (no embedded ECS/deployer Terraform)', () => {
    const paths = Object.keys(enterpriseTerraformAssets);
    // The updater (an on-box binary) + the signed app bundle own the app tier and
    // its scheduling now; there is no ECS service/task-def or scheduler Terraform.
    for (const path of paths) {
      const content = enterpriseTerraformAssets[path]!;
      expect(content, path).not.toContain('resource "aws_ecs_service"');
      expect(content, path).not.toContain('resource "aws_ecs_task_definition"');
      expect(content, path).not.toContain('resource "aws_scheduler_schedule"');
      expect(content, path).not.toContain('resource "aws_lb"');
    }
  });
});
