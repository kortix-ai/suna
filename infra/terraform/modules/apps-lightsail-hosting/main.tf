terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0"
    }
  }
}

data "aws_partition" "current" {}
data "aws_caller_identity" "current" {}

locals {
  resource_name = "${var.name}-apps-hosting"
  common_tags = merge(var.tags, {
    Component   = "apps-hosting"
    Environment = var.environment
    ManagedBy   = "terraform"
  })
}

data "aws_iam_policy_document" "encryption" {
  #checkov:skip=CKV_AWS_109:The account-root statement is the KMS administration boundary; CloudWatch Logs receives only encryption data-plane actions.
  #checkov:skip=CKV_AWS_111:The account root must administer this module-owned key; the service statement cannot change IAM or resource policies.
  #checkov:skip=CKV_AWS_356:KMS key policies require Resource "*" before the key ARN exists; principals and the CloudWatch encryption context constrain access.
  statement {
    sid       = "EnableAccountAdministration"
    actions   = ["kms:*"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:root"]
    }
  }

  statement {
    sid = "AllowCodeBuildLogs"
    actions = [
      "kms:Decrypt",
      "kms:DescribeKey",
      "kms:Encrypt",
      "kms:GenerateDataKey*",
      "kms:ReEncrypt*",
    ]
    resources = ["*"]
    principals {
      type        = "Service"
      identifiers = ["logs.${data.aws_region.current.region}.amazonaws.com"]
    }
    condition {
      test     = "ArnLike"
      variable = "kms:EncryptionContext:aws:logs:arn"
      values   = ["arn:${data.aws_partition.current.partition}:logs:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/codebuild/${local.resource_name}"]
    }
  }
}

data "aws_region" "current" {}

resource "aws_kms_key" "apps_hosting" {
  description             = "Apps hosting build, image, and log encryption for ${local.resource_name}"
  deletion_window_in_days = 30
  enable_key_rotation     = true
  policy                  = data.aws_iam_policy_document.encryption.json
  tags                    = local.common_tags
}

resource "aws_kms_alias" "apps_hosting" {
  name          = "alias/${local.resource_name}"
  target_key_id = aws_kms_key.apps_hosting.key_id
}

#trivy:ignore:AVD-AWS-0089 Build contexts are deleted after each build and expire after two days. A second access-log bucket would add a longer-lived data store for ephemeral inputs.
resource "aws_s3_bucket" "build_contexts" {
  #checkov:skip=CKV_AWS_18:Build contexts are short-lived inputs, not an audit-log source.
  #checkov:skip=CKV_AWS_144:Build contexts are disposable and rebuilt from the immutable App artifact.
  #checkov:skip=CKV2_AWS_62:The API and lifecycle policy consume this private bucket; event notifications are not required.
  bucket_prefix = "${local.resource_name}-"
  force_destroy = false
  tags          = local.common_tags
}

resource "aws_s3_bucket_public_access_block" "build_contexts" {
  bucket                  = aws_s3_bucket.build_contexts.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "build_contexts" {
  bucket = aws_s3_bucket.build_contexts.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "build_contexts" {
  bucket = aws_s3_bucket.build_contexts.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "build_contexts" {
  bucket = aws_s3_bucket.build_contexts.id
  rule {
    apply_server_side_encryption_by_default {
      kms_master_key_id = aws_kms_key.apps_hosting.arn
      sse_algorithm     = "aws:kms"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "build_contexts" {
  #checkov:skip=CKV_AWS_300:The lifecycle has abort_incomplete_multipart_upload at one day; Checkov does not associate the split AWS provider lifecycle resource with the bucket.
  bucket = aws_s3_bucket.build_contexts.id
  rule {
    id     = "expire-build-contexts"
    status = "Enabled"
    filter {
      prefix = "apps/"
    }
    expiration {
      days = 2
    }
    noncurrent_version_expiration {
      noncurrent_days = 1
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

resource "aws_ecr_repository" "apps" {
  name                 = local.resource_name
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration {
    scan_on_push = true
  }
  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = aws_kms_key.apps_hosting.arn
  }
  tags = local.common_tags
}

resource "aws_ecr_lifecycle_policy" "apps" {
  repository = aws_ecr_repository.apps.name
  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Delete untagged interrupted-build layers after one day"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 1
        }
        action = { type = "expire" }
      },
    ]
  })
}

data "aws_iam_policy_document" "codebuild_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["codebuild.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "codebuild" {
  name               = "${local.resource_name}-codebuild"
  assume_role_policy = data.aws_iam_policy_document.codebuild_assume.json
  tags               = local.common_tags
}

resource "aws_cloudwatch_log_group" "codebuild" {
  name              = "/aws/codebuild/${local.resource_name}"
  retention_in_days = 365
  kms_key_id        = aws_kms_key.apps_hosting.arn
  tags              = local.common_tags
}

data "aws_iam_policy_document" "codebuild" {
  statement {
    sid = "BuildLogs"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["${aws_cloudwatch_log_group.codebuild.arn}:*"]
  }
  statement {
    sid       = "ReadBuildContexts"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.build_contexts.arn}/apps/*"]
  }
  statement {
    sid = "DecryptBuildContexts"
    actions = [
      "kms:Decrypt",
      "kms:DescribeKey",
    ]
    resources = [aws_kms_key.apps_hosting.arn]
  }
  statement {
    sid       = "EcrLogin"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    sid = "PushDeploymentImages"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:CompleteLayerUpload",
      "ecr:GetDownloadUrlForLayer",
      "ecr:InitiateLayerUpload",
      "ecr:PutImage",
      "ecr:UploadLayerPart",
    ]
    resources = [aws_ecr_repository.apps.arn]
  }
}

resource "aws_iam_role_policy" "codebuild" {
  name   = "${local.resource_name}-build"
  role   = aws_iam_role.codebuild.id
  policy = data.aws_iam_policy_document.codebuild.json
}

resource "aws_codebuild_project" "apps" {
  #checkov:skip=CKV_AWS_316:Docker-in-Docker requires privileged mode. The build is ephemeral and the role is limited to one build prefix, one immutable ECR repository, its KMS key, and its log group.
  name          = local.resource_name
  service_role  = aws_iam_role.codebuild.arn
  build_timeout = 15

  artifacts {
    type = "NO_ARTIFACTS"
  }

  environment {
    compute_type                = "BUILD_GENERAL1_SMALL"
    image                       = "aws/codebuild/standard:7.0"
    type                        = "LINUX_CONTAINER"
    image_pull_credentials_type = "CODEBUILD"
    privileged_mode             = true
  }

  source {
    type      = "NO_SOURCE"
    buildspec = "version: 0.2\nphases:\n  build:\n    commands:\n      - echo buildspecOverride is required\n"
  }

  logs_config {
    cloudwatch_logs {
      group_name  = aws_cloudwatch_log_group.codebuild.name
      stream_name = "apps"
    }
  }

  tags = local.common_tags
}

data "aws_iam_policy_document" "api_task" {
  #checkov:skip=CKV_AWS_111:Lightsail Container Services does not support resource-level permissions for these create, deployment, update, log, and delete actions. Environment-prefixed names and tags bound every created resource.
  #checkov:skip=CKV_AWS_356:Lightsail Container Services requires Resource "*" for the listed control-plane actions. Every resource name is environment-prefixed and every create request is tagged.
  statement {
    sid = "RunAppImageBuilds"
    actions = [
      "codebuild:BatchGetBuilds",
      "codebuild:StartBuild",
    ]
    resources = [aws_codebuild_project.apps.arn]
  }
  statement {
    sid = "ManageBuildContexts"
    actions = [
      "s3:ListBucket",
      "s3:GetBucketLocation",
    ]
    resources = [aws_s3_bucket.build_contexts.arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["apps/${var.environment}/*"]
    }
  }
  statement {
    sid = "ManageBuildContextObjects"
    actions = [
      "s3:DeleteObject",
      "s3:GetObject",
      "s3:PutObject",
    ]
    resources = ["${aws_s3_bucket.build_contexts.arn}/apps/${var.environment}/*"]
  }
  statement {
    sid = "EncryptBuildContexts"
    actions = [
      "kms:Decrypt",
      "kms:DescribeKey",
      "kms:Encrypt",
      "kms:GenerateDataKey*",
    ]
    resources = [aws_kms_key.apps_hosting.arn]
  }
  statement {
    sid = "ManageDeploymentImagesAndPullPolicies"
    actions = [
      "ecr:BatchDeleteImage",
      "ecr:DeleteRepositoryPolicy",
      "ecr:DescribeImages",
      "ecr:GetRepositoryPolicy",
      "ecr:SetRepositoryPolicy",
    ]
    resources = [aws_ecr_repository.apps.arn]
  }
  statement {
    sid = "ManageLightsailAppContainers"
    actions = [
      "lightsail:CreateContainerService",
      "lightsail:CreateContainerServiceDeployment",
      "lightsail:DeleteContainerService",
      "lightsail:GetContainerLog",
      "lightsail:GetContainerServices",
      "lightsail:TagResource",
      "lightsail:UpdateContainerService",
    ]
    resources = ["*"]
  }
  statement {
    sid       = "CreateLightsailServiceLinkedRole"
    actions   = ["iam:CreateServiceLinkedRole"]
    resources = ["arn:${data.aws_partition.current.partition}:iam::*:role/aws-service-role/lightsail.amazonaws.com/*"]
    condition {
      test     = "StringEquals"
      variable = "iam:AWSServiceName"
      values   = ["lightsail.amazonaws.com"]
    }
  }
}
