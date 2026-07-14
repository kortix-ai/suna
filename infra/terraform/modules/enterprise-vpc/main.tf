data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}
data "aws_region" "current" {}

data "aws_ssm_parameter" "al2023_ami" {
  count = var.supabase_ami_id == null ? 1 : 0
  name  = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

locals {
  region       = data.aws_region.current.region
  partition    = data.aws_partition.current.partition
  supabase_ami = coalesce(var.supabase_ami_id, try(data.aws_ssm_parameter.al2023_ami[0].value, null))
  kms_owner_actions = [
    "kms:CancelKeyDeletion",
    "kms:CreateAlias",
    "kms:CreateGrant",
    "kms:CreateKey",
    "kms:Decrypt",
    "kms:DeleteAlias",
    "kms:DeleteImportedKeyMaterial",
    "kms:DescribeKey",
    "kms:DisableKey",
    "kms:DisableKeyRotation",
    "kms:EnableKey",
    "kms:EnableKeyRotation",
    "kms:Encrypt",
    "kms:GenerateDataKey*",
    "kms:GetKeyPolicy",
    "kms:GetKeyRotationStatus",
    "kms:GetParametersForImport",
    "kms:GetPublicKey",
    "kms:ImportKeyMaterial",
    "kms:ListAliases",
    "kms:ListGrants",
    "kms:ListKeyPolicies",
    "kms:ListKeys",
    "kms:ListResourceTags",
    "kms:ListRetirableGrants",
    "kms:PutKeyPolicy",
    "kms:ReEncrypt*",
    "kms:ReplicateKey",
    "kms:RetireGrant",
    "kms:RevokeGrant",
    "kms:ScheduleKeyDeletion",
    "kms:Sign",
    "kms:SynchronizeMultiRegionKey",
    "kms:TagResource",
    "kms:UntagResource",
    "kms:UpdateAlias",
    "kms:UpdateKeyDescription",
    "kms:UpdatePrimaryRegion",
    "kms:Verify",
  ]
  tags = merge(var.tags, {
    ManagedBy         = "terraform"
    Platform          = "kortix-enterprise"
    KortixInstance    = var.name
    DataBoundary      = "customer-account"
    "kortix:instance" = var.name
  })

  # Naming contract discovered by the deployer + `kortix self-host` from the
  # instance slug alone: cluster kortix-<instance>; services/task-def families
  # kortix-<instance>-<role>; secret <instance>/runtime; SSM /kortix/<instance>/release.
  cluster_name    = "kortix-${var.name}"
  api_family      = "kortix-${var.name}-api"
  gateway_family  = "kortix-${var.name}-gateway"
  frontend_family = "kortix-${var.name}-frontend"
  migrate_family  = "kortix-${var.name}-migrate"
  deployer_family = "kortix-${var.name}-deployer"
  release_ssm_param = "/kortix/${var.name}/release"

  # ALB + target-group names cap at 32 chars; keep a compact, hyphen-safe base.
  lb_base = trimsuffix(substr("kortix-${var.name}", 0, 27), "-")

  # Digest-pinned images are owned by the deployer at runtime; Terraform seeds a
  # harmless long-lived placeholder so the task-defs and services exist first.
  api_image      = coalesce(var.api_image, var.placeholder_image)
  gateway_image  = coalesce(var.gateway_image, var.placeholder_image)
  frontend_image = coalesce(var.frontend_image, var.placeholder_image)
  deployer_image = coalesce(var.deployer_image, var.placeholder_image)

  # Initial secrets bootstrap: name -> runtime-secret JSON key ARN reference, the
  # same valueFrom shape ecs-deploy.sh emits. The deployer re-derives the full set
  # from the live secret keys on every roll, so this list is only the seed.
  runtime_secrets = {
    for key in var.runtime_secret_keys : key => "${aws_secretsmanager_secret.runtime.arn}:${key}::"
  }
}

resource "terraform_data" "account_guard" {
  input = data.aws_caller_identity.current.account_id

  lifecycle {
    precondition {
      condition     = data.aws_caller_identity.current.account_id == var.expected_account_id
      error_message = "AWS account mismatch: refusing to manage ${var.name} outside account ${var.expected_account_id}."
    }
    precondition {
      condition     = var.api_min_capacity >= 2 && var.gateway_min_capacity >= 2
      error_message = "Enterprise availability requires at least two tasks for the api and gateway services."
    }
  }
}
