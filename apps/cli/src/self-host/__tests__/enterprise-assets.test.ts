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

  test('embeds the ALB controller policy as text for the compiled CLI', () => {
    const policy = enterpriseTerraformAssets['modules/eks/platform/files/alb-controller-policy.json'];
    expect(typeof policy).toBe('string');
    expect(JSON.parse(policy)).toMatchObject({ Version: '2012-10-17' });
  });

  test('accepts only the Route 53 apex or a label-bounded subdomain after provider name normalization', () => {
    const acm = enterpriseTerraformAssets['modules/enterprise-vpc/acm.tf'];
    expect(acm).toContain('lower(trimsuffix(data.aws_route53_zone.public.name, "."))');
    expect(acm).toContain('lower(domain) == local.public_zone_name');
    expect(acm).toContain('endswith(lower(domain), ".${local.public_zone_name}")');
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

  test('embeds three ECS services with the deployment circuit breaker enabled', () => {
    const ecs = enterpriseTerraformAssets['modules/enterprise-vpc/ecs.tf'];
    expect(ecs).toContain('resource "aws_ecs_cluster"');
    for (const role of ['api', 'gateway', 'frontend']) {
      expect(ecs).toContain(`resource "aws_ecs_service" "${role}"`);
    }
    // circuit breaker owns bad-task-def rollback (the deployer never hand-rolls it)
    expect(ecs.match(/deployment_circuit_breaker\s*{[^}]*rollback\s*=\s*true/g)?.length).toBe(3);
    expect(ecs).toContain('resource "aws_ecs_task_definition" "migrate"');
    expect(ecs).toContain('resource "aws_ecs_task_definition" "deployer"');
  });

  test('grants the gateway task role Bedrock invoke for managed Claude with no OpenRouter dependency', () => {
    const ecs = enterpriseTerraformAssets['modules/enterprise-vpc/ecs.tf'];
    expect(ecs).toContain('resource "aws_iam_role" "gateway_task"');
    expect(ecs).toContain('bedrock:InvokeModel');
    expect(ecs).toContain('bedrock:InvokeModelWithResponseStream');
  });

  test('passes the deployer its ECS naming + release breadcrumb contract by environment', () => {
    const ecs = enterpriseTerraformAssets['modules/enterprise-vpc/ecs.tf'];
    for (const key of [
      'KORTIX_CLUSTER', 'KORTIX_API_SERVICE', 'KORTIX_GATEWAY_SERVICE', 'KORTIX_FRONTEND_SERVICE',
      'KORTIX_MIGRATE_TASKDEF', 'KORTIX_RELEASE_SSM_PARAM', 'KORTIX_ECR_REPOSITORIES',
    ]) {
      expect(ecs).toContain(key);
    }
  });

  test('drives auto-updates from a scheduled ecs:RunTask of the deployer, not a state machine', () => {
    const deployer = enterpriseTerraformAssets['modules/enterprise-vpc/deployer.tf'];
    expect(deployer).toContain('resource "aws_scheduler_schedule" "deployer"');
    expect(deployer).toContain('ecs:RunTask');
    expect(deployer).toContain('resource "aws_ssm_parameter" "release"');
    // the deployer task role rolls services + reads/writes the release breadcrumb,
    // it does not carry a Step Functions / CodeBuild reconciler any more
    expect(deployer).not.toContain('aws_sfn_state_machine');
    expect(deployer).not.toContain('aws_codebuild_project');
  });
});
