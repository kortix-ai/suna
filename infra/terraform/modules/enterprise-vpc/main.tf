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

  # Naming contract discovered by the on-box updater + `kortix self-host` from the
  # instance slug alone: secret <instance>/runtime; SSM /kortix/<instance>/release;
  # customer ECR mirror repos <instance>/<role>; log groups /kortix/<instance>/*.
  release_ssm_param = "/kortix/${var.name}/release"

  # Zone-scoped ARN for the customer public hosted zone (ACME DNS-01 + app records).
  route53_zone_arn = "arn:${local.partition}:route53:::hostedzone/${var.route53_zone_id}"
}

resource "terraform_data" "account_guard" {
  input = data.aws_caller_identity.current.account_id

  lifecycle {
    precondition {
      condition     = data.aws_caller_identity.current.account_id == var.expected_account_id
      error_message = "AWS account mismatch: refusing to manage ${var.name} outside account ${var.expected_account_id}."
    }
  }
}
