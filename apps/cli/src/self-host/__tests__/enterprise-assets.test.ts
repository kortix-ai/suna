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

  test('embeds the reviewed controller trust plane used by cluster outputs', () => {
    const controllerIrsa = enterpriseTerraformAssets['modules/enterprise-vpc/controller-irsa.tf'];
    expect(controllerIrsa).toContain('module "alb_controller_irsa"');
    expect(controllerIrsa).toContain('module "external_dns_irsa"');
    expect(controllerIrsa).toContain('route53:ChangeResourceRecordSets');
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

  test('keeps the customer updater as the only enterprise Helm reconciler', () => {
    const sharedPlatform = enterpriseTerraformAssets['modules/eks/platform/main.tf'];
    const enterprisePlatform = enterpriseTerraformAssets['modules/enterprise-platform/main.tf'];

    expect(sharedPlatform).toContain('count            = var.argo_cd_enabled ? 1 : 0');
    expect(enterprisePlatform).toContain('argo_cd_enabled             = false');
    expect(enterprisePlatform).not.toContain('resource "kubernetes_manifest"');
  });

  test('allows only the customer updater security group into the private EKS API', () => {
    const eks = enterpriseTerraformAssets['modules/enterprise-vpc/eks.tf'];
    const rule = eks.slice(
      eks.indexOf('resource "aws_vpc_security_group_ingress_rule" "updater_eks_api"'),
      eks.indexOf('data "aws_iam_policy_document" "app_secrets"'),
    );

    expect(rule).toContain('security_group_id            = module.eks.cluster_security_group_id');
    expect(rule).toContain('referenced_security_group_id = aws_security_group.updater.id');
    expect(rule).toContain('ip_protocol                  = "tcp"');
    expect(rule).toContain('from_port                    = 443');
    expect(rule).toContain('to_port                      = 443');
    expect(rule).not.toContain('cidr_ipv4');
  });

  test('recovers missed publisher hints through the same authoritative hourly reconciler', () => {
    const updater = enterpriseTerraformAssets['modules/enterprise-vpc/updater.tf'];
    const hintTarget = updater.slice(
      updater.indexOf('resource "aws_cloudwatch_event_target" "release_hint"'),
      updater.indexOf('resource "aws_cloudwatch_event_rule" "hourly"'),
    );
    const hourlyTarget = updater.slice(
      updater.indexOf('resource "aws_cloudwatch_event_target" "hourly"'),
    );

    expect(hintTarget).toContain('arn            = aws_sfn_state_machine.reconcile.arn');
    expect(hourlyTarget).toContain('arn      = aws_sfn_state_machine.reconcile.arn');
    expect(hourlyTarget).toContain('trigger = "hourly"');
    expect(hourlyTarget).toContain('force   = false');
  });

  test('scopes SSM send while allowing the updater to observe command completion', () => {
    const updater = enterpriseTerraformAssets['modules/enterprise-vpc/updater.tf'];
    const send = updater.slice(
      updater.indexOf('sid     = "SendSupabaseCommand"'),
      updater.indexOf('sid = "ObserveSupabaseCommand"'),
    );
    const observe = updater.slice(
      updater.indexOf('sid = "ObserveSupabaseCommand"'),
      updater.indexOf('sid       = "ReadRuntimeSecrets"'),
    );

    expect(send).toContain('actions = ["ssm:SendCommand"]');
    expect(send).toContain('aws_instance.supabase.arn');
    expect(observe).toContain('"ssm:GetCommandInvocation"');
    expect(observe).toContain('"ssm:ListCommandInvocations"');
    expect(observe).toContain('resources = ["*"]');
  });

  test('does not grant the automatic platform apply role AWS infrastructure mutation', () => {
    const updater = enterpriseTerraformAssets['modules/enterprise-vpc/updater.tf'];
    const applyPolicy = updater.slice(
      updater.indexOf('data "aws_iam_policy_document" "updater_apply"'),
      updater.indexOf('resource "aws_iam_role_policy" "updater_apply"'),
    );

    expect(applyPolicy).toContain('eks:DescribeCluster');
    expect(applyPolicy).toContain('sts:GetCallerIdentity');
    expect(applyPolicy).not.toContain('ManageTaggedKortixInfrastructure');
    expect(applyPolicy).not.toMatch(/"(?:autoscaling|backup|cloudwatch|codebuild|ec2|ecr|eks|elasticloadbalancing|events|logs|secretsmanager|ssm|states|tag):\*"/);
  });

  test('lets the platform apply role read the pinned cluster remote state', () => {
    const updater = enterpriseTerraformAssets['modules/enterprise-vpc/updater.tf'];
    const applyPolicy = updater.slice(
      updater.indexOf('data "aws_iam_policy_document" "updater_apply"'),
      updater.indexOf('resource "aws_iam_role_policy" "updater_apply"'),
    );

    expect(applyPolicy).toContain('sid       = "ReadClusterTerraformState"');
    expect(applyPolicy).toContain('actions   = ["s3:GetObject"]');
    expect(applyPolicy).toContain('"arn:${local.partition}:s3:::${var.terraform_state_bucket}/enterprise/cluster.tfstate"');
  });
});
