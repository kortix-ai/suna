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

locals {
  resource_name = "${var.name}-apps-hosting"
  common_tags = merge(var.tags, {
    Component   = "apps-hosting"
    Environment = var.environment
    ManagedBy   = "terraform"
  })
}

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
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "build_contexts" {
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
    encryption_type = "AES256"
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
