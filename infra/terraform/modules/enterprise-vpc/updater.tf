resource "aws_dynamodb_table" "release_state" {
  name         = "${var.name}-release-state"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "instance"

  attribute {
    name = "instance"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled     = true
    kms_key_arn = aws_kms_key.data.arn
  }

  deletion_protection_enabled = true
  tags                        = local.tags
}

resource "aws_security_group" "updater" {
  name_prefix = "${var.name}-updater-"
  description = "Customer-owned release reconciler; no ingress"
  vpc_id      = module.network.vpc_id

  # The reconciler reaches the public TUF origin and OCI registries through the
  # VPC NAT gateway. AWS API traffic uses private endpoints, ingress is empty,
  # and this exception is TCP/443 only.
  #trivy:ignore:AVD-AWS-0104
  egress {
    description = "TLS to TUF repository and AWS endpoints"
    protocol    = "tcp"
    from_port   = 443
    to_port     = 443
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description = "DNS to VPC resolver"
    protocol    = "udp"
    from_port   = 53
    to_port     = 53
    cidr_blocks = ["${cidrhost(var.vpc_cidr, 2)}/32"]
  }

  tags = merge(local.tags, { Name = "${var.name}-updater" })
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
  name                 = "${var.name}-updater-runner"
  assume_role_policy   = data.aws_iam_policy_document.codebuild_assume.json
  permissions_boundary = var.permissions_boundary_arn
  tags                 = local.tags
}

data "aws_iam_policy_document" "codebuild" {
  #checkov:skip=CKV_AWS_111:AWS describe calls, ECR authorization, and VPC ENI discovery do not support resource-level ARNs; all write-capable statements below use installation resources.
  #checkov:skip=CKV_AWS_356:Only AWS APIs that require Resource star use it; mutation statements are scoped to the customer installation.
  statement {
    sid = "Logs"
    actions = [
      "logs:CreateLogGroup",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["arn:${local.partition}:logs:${local.region}:${var.expected_account_id}:log-group:/kortix/${var.name}/updater*"]
  }

  statement {
    sid = "VpcBuildNetworking"
    actions = [
      "ec2:CreateNetworkInterface",
      "ec2:DeleteNetworkInterface",
      "ec2:DescribeDhcpOptions",
      "ec2:DescribeNetworkInterfaces",
      "ec2:DescribeSecurityGroups",
      "ec2:DescribeSubnets",
      "ec2:DescribeVpcs",
    ]
    resources = ["*"]
  }

  statement {
    sid       = "VpcBuildPermissionCheck"
    actions   = ["ec2:CreateNetworkInterfacePermission"]
    resources = ["arn:${local.partition}:ec2:${local.region}:${var.expected_account_id}:network-interface/*"]
    condition {
      test     = "StringEquals"
      variable = "ec2:Subnet"
      values   = [for id in module.network.private_subnet_ids : "arn:${local.partition}:ec2:${local.region}:${var.expected_account_id}:subnet/${id}"]
    }
  }

  statement {
    sid = "ReleaseState"
    actions = [
      "dynamodb:DescribeTable",
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:Query",
      "dynamodb:UpdateItem",
    ]
    resources = [aws_dynamodb_table.release_state.arn]
  }

  statement {
    sid = "MirrorReleaseArtifacts"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:CompleteLayerUpload",
      "ecr:DescribeImages",
      "ecr:GetDownloadUrlForLayer",
      "ecr:InitiateLayerUpload",
      "ecr:ListImages",
      "ecr:PutImage",
      "ecr:UploadLayerPart",
    ]
    resources = [for repository in aws_ecr_repository.enterprise : repository.arn]
  }

  statement {
    sid = "PersistVerifiedUpdaterMetadata"
    actions = [
      "s3:GetObject",
      "s3:PutObject",
    ]
    resources = [
      "${aws_s3_bucket.backups.arn}/updater-metadata/${var.name}/*",
      "${aws_s3_bucket.backups.arn}/updater-staging/*",
    ]
  }

  statement {
    sid       = "ListVerifiedUpdaterMetadata"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.backups.arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["updater-metadata/${var.name}/*", "updater-staging/*"]
    }
  }

  statement {
    sid       = "EcrLogin"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid     = "SendSupabaseCommand"
    actions = ["ssm:SendCommand"]
    resources = [
      aws_instance.supabase.arn,
      "arn:${local.partition}:ssm:${local.region}::document/AWS-RunShellScript",
    ]
  }

  # GetCommandInvocation and ListCommandInvocations do not support resource
  # scoping. Keep command submission pinned to the host/document above, while
  # allowing the runner to wait for that submitted command to finish.
  statement {
    sid = "ObserveSupabaseCommand"
    actions = [
      "ssm:GetCommandInvocation",
      "ssm:ListCommandInvocations",
    ]
    resources = ["*"]
  }

  statement {
    sid       = "ReadRuntimeSecrets"
    actions   = ["secretsmanager:DescribeSecret", "secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.runtime.arn, aws_secretsmanager_secret.updater.arn]
  }

  statement {
    sid       = "UseCustomerKeys"
    actions   = ["kms:Decrypt", "kms:DescribeKey", "kms:GenerateDataKey"]
    resources = [aws_kms_key.data.arn, aws_kms_key.secrets.arn]
  }

  statement {
    sid       = "AssumeGuardedApplyRole"
    actions   = ["sts:AssumeRole"]
    resources = [aws_iam_role.updater_apply.arn]
  }
}

resource "aws_iam_role_policy" "codebuild" {
  name   = "${var.name}-updater-runner"
  role   = aws_iam_role.codebuild.id
  policy = data.aws_iam_policy_document.codebuild.json
}

data "aws_iam_policy_document" "updater_apply_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "AWS"
      identifiers = [aws_iam_role.codebuild.arn]
    }
  }
}

resource "aws_iam_role" "updater_apply" {
  name                 = "${var.name}-updater-apply"
  assume_role_policy   = data.aws_iam_policy_document.updater_apply_assume.json
  permissions_boundary = var.permissions_boundary_arn
  max_session_duration = 3600
  tags                 = local.tags
}

data "aws_iam_policy_document" "updater_apply" {
  statement {
    sid = "ReadPinnedCluster"
    actions = [
      "eks:DescribeCluster",
    ]
    resources = [module.eks.cluster_arn]
  }

  statement {
    sid = "ManagePlatformTerraformState"
    actions = [
      "s3:GetObject",
      "s3:ListBucket",
      "s3:PutObject",
    ]
    resources = [
      "arn:${local.partition}:s3:::${var.terraform_state_bucket}",
      "arn:${local.partition}:s3:::${var.terraform_state_bucket}/enterprise/platform.tfstate",
    ]
  }

  statement {
    sid = "LockPlatformTerraformState"
    actions = [
      "dynamodb:DeleteItem",
      "dynamodb:DescribeTable",
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
    ]
    resources = ["arn:${local.partition}:dynamodb:${local.region}:${var.expected_account_id}:table/${var.terraform_state_lock_table}"]
  }

  statement {
    sid       = "UsePlatformTerraformStateKey"
    actions   = ["kms:Decrypt", "kms:DescribeKey", "kms:Encrypt", "kms:GenerateDataKey"]
    resources = [var.terraform_state_kms_key_arn]
  }

  statement {
    sid       = "VerifyAssumedIdentity"
    actions   = ["sts:GetCallerIdentity"]
    resources = ["*"]
  }

  # Defense in depth: keep the destructive/trust-boundary deny even though the
  # automatic role has no AWS infrastructure mutation grant. Future policy
  # additions therefore fail closed unless this deny is also reviewed.
  statement {
    sid    = "DenyDestructiveOrBoundaryChanges"
    effect = "Deny"
    actions = [
      "autoscaling:Delete*",
      "backup:Delete*",
      "codebuild:Delete*",
      "dynamodb:DeleteTable",
      "ec2:AssociateRouteTable",
      "ec2:AuthorizeSecurityGroup*",
      "ec2:CreateInternetGateway",
      "ec2:CreateNatGateway",
      "ec2:CreateNetworkAcl*",
      "ec2:CreateRoute*",
      "ec2:CreateSecurityGroup",
      "ec2:CreateSubnet",
      "ec2:CreateVpc*",
      "ec2:Delete*",
      "ec2:DisassociateRouteTable",
      "ec2:ModifyInstanceAttribute",
      "ec2:ModifyNetworkInterfaceAttribute",
      "ec2:ModifySubnetAttribute",
      "ec2:ModifyVpc*",
      "ec2:ReplaceNetworkAcl*",
      "ec2:ReplaceRoute*",
      "ec2:RevokeSecurityGroup*",
      "ec2:TerminateInstances",
      "ecr:BatchDeleteImage",
      "ecr:Delete*",
      "eks:AssociateAccessPolicy",
      "eks:CreateAccessEntry",
      "eks:Delete*",
      "eks:DisassociateAccessPolicy",
      "eks:UpdateAccessEntry",
      "eks:UpdateClusterConfig",
      "elasticloadbalancing:Delete*",
      "elasticloadbalancing:SetSecurityGroups",
      "elasticloadbalancing:SetSubnets",
      "events:Delete*",
      "events:PutPermission",
      "events:RemovePermission",
      "logs:Delete*",
      "s3:Delete*",
      "s3:PutAccountPublicAccessBlock",
      "s3:PutBucketAcl",
      "s3:PutBucketPolicy",
      "s3:PutBucketPublicAccessBlock",
      "secretsmanager:Delete*",
      "secretsmanager:PutResourcePolicy",
      "ssm:Delete*",
      "states:Delete*",
      "tag:UntagResources",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "updater_apply" {
  name   = "${var.name}-guarded-terraform-apply"
  role   = aws_iam_role.updater_apply.id
  policy = data.aws_iam_policy_document.updater_apply.json
}

resource "aws_eks_access_entry" "updater" {
  cluster_name  = module.eks.cluster_name
  principal_arn = aws_iam_role.updater_apply.arn
  type          = "STANDARD"
}

resource "aws_eks_access_policy_association" "updater" {
  cluster_name  = module.eks.cluster_name
  principal_arn = aws_iam_role.updater_apply.arn
  policy_arn    = "arn:${local.partition}:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy"
  access_scope {
    type = "cluster"
  }
  depends_on = [aws_eks_access_entry.updater]
}

resource "aws_cloudwatch_log_group" "updater" {
  name              = "/kortix/${var.name}/updater"
  retention_in_days = 365
  kms_key_id        = aws_kms_key.data.arn
  tags              = local.tags
}

resource "aws_codebuild_project" "updater" {
  name          = "${var.name}-updater"
  description   = "Customer-owned, digest-pinned Kortix stable reconciler"
  service_role  = aws_iam_role.codebuild.arn
  build_timeout = 60

  artifacts { type = "NO_ARTIFACTS" }
  source {
    type      = "NO_SOURCE"
    buildspec = templatefile("${path.module}/files/updater-buildspec.yml.tftpl", {})
  }

  environment {
    compute_type                = "BUILD_GENERAL1_MEDIUM"
    image                       = "aws/codebuild/amazonlinux-x86_64-standard:5.0"
    type                        = "LINUX_CONTAINER"
    image_pull_credentials_type = "CODEBUILD"
    privileged_mode             = false

    environment_variable {
      name  = "KORTIX_INSTANCE"
      value = var.name
    }
    environment_variable {
      name  = "KORTIX_CHANNEL"
      value = var.release_channel
    }
    environment_variable {
      name  = "KORTIX_RELEASE_REPOSITORY"
      value = var.release_repository_url
    }
    environment_variable {
      name  = "KORTIX_TUF_ROOT_SHA256"
      value = var.tuf_root_sha256
      type  = "PLAINTEXT"
    }
    environment_variable {
      name  = "KORTIX_UPDATER_BOOTSTRAP_URL"
      value = var.updater_bootstrap_url
    }
    environment_variable {
      name  = "KORTIX_UPDATER_BOOTSTRAP_SHA256"
      value = var.updater_bootstrap_sha256
      type  = "PLAINTEXT"
    }
    environment_variable {
      name  = "KORTIX_STATE_TABLE"
      value = aws_dynamodb_table.release_state.name
    }
    environment_variable {
      name  = "KORTIX_APPLY_ROLE_ARN"
      value = aws_iam_role.updater_apply.arn
    }
    environment_variable {
      name  = "KORTIX_MAINTENANCE_WINDOW"
      value = var.maintenance_window
    }
    environment_variable {
      name  = "KORTIX_RUNTIME_SECRET_ARN"
      value = aws_secretsmanager_secret.runtime.arn
    }
    environment_variable {
      name  = "KORTIX_SUPABASE_INSTANCE_ID"
      value = aws_instance.supabase.id
    }
    environment_variable {
      name  = "KORTIX_EXPECTED_ACCOUNT_ID"
      value = var.expected_account_id
    }
    environment_variable {
      name  = "KORTIX_CLUSTER_NAME"
      value = module.eks.cluster_name
    }
    environment_variable {
      name  = "KORTIX_KUBERNETES_MINOR"
      value = var.cluster_version
    }
    environment_variable {
      name  = "KORTIX_STATE_BUCKET"
      value = var.terraform_state_bucket
    }
    environment_variable {
      name  = "KORTIX_STATE_LOCK_TABLE"
      value = var.terraform_state_lock_table
    }
    environment_variable {
      name  = "KORTIX_STATE_KMS_KEY_ARN"
      value = var.terraform_state_kms_key_arn
    }
    environment_variable {
      name  = "KORTIX_BACKUP_BUCKET"
      value = aws_s3_bucket.backups.id
    }
    environment_variable {
      name  = "KORTIX_BACKUP_KMS_KEY_ARN"
      value = aws_kms_key.data.arn
    }
    environment_variable {
      name  = "KORTIX_ECR_REPOSITORIES"
      value = jsonencode({ for name, repository in aws_ecr_repository.enterprise : name => repository.repository_url })
    }
    environment_variable {
      name  = "KORTIX_API_DOMAIN"
      value = var.api_domain
    }
    environment_variable {
      name  = "KORTIX_FRONTEND_DOMAIN"
      value = var.frontend_domain
    }
    environment_variable {
      name  = "KORTIX_CERTIFICATE_ARN"
      value = aws_acm_certificate.public.arn
    }
    environment_variable {
      name  = "KORTIX_SUPABASE_PRIVATE_IP"
      value = aws_instance.supabase.private_ip
    }
    environment_variable {
      name  = "KORTIX_APP_SERVICE_ACCOUNT"
      value = var.app_service_account
    }
  }

  logs_config {
    cloudwatch_logs {
      group_name  = aws_cloudwatch_log_group.updater.name
      stream_name = "reconcile"
    }
  }

  vpc_config {
    vpc_id             = module.network.vpc_id
    subnets            = module.network.private_subnet_ids
    security_group_ids = [aws_security_group.updater.id]
  }

  tags = local.tags
}

data "aws_iam_policy_document" "states_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["states.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "states" {
  name                 = "${var.name}-reconcile-state-machine"
  assume_role_policy   = data.aws_iam_policy_document.states_assume.json
  permissions_boundary = var.permissions_boundary_arn
  tags                 = local.tags
}

data "aws_iam_policy_document" "states" {
  statement {
    actions   = ["codebuild:StartBuild", "codebuild:BatchGetBuilds", "codebuild:StopBuild"]
    resources = [aws_codebuild_project.updater.arn]
  }
  statement {
    actions = ["events:PutRule", "events:PutTargets", "events:DescribeRule"]
    resources = [
      "arn:${local.partition}:events:${local.region}:${var.expected_account_id}:rule/StepFunctionsGetEventForCodeBuildStartBuildRule",
    ]
  }
  statement {
    actions = [
      "logs:CreateLogDelivery",
      "logs:DeleteLogDelivery",
      "logs:DescribeLogGroups",
      "logs:DescribeResourcePolicies",
      "logs:GetLogDelivery",
      "logs:ListLogDeliveries",
      "logs:PutResourcePolicy",
      "logs:UpdateLogDelivery",
    ]
    resources = ["*"]
  }
  statement {
    actions   = ["xray:PutTraceSegments", "xray:PutTelemetryRecords"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "states" {
  name   = "${var.name}-run-updater"
  role   = aws_iam_role.states.id
  policy = data.aws_iam_policy_document.states.json
}

resource "aws_sfn_state_machine" "reconcile" {
  name     = "${var.name}-reconcile"
  role_arn = aws_iam_role.states.arn
  type     = "STANDARD"

  logging_configuration {
    include_execution_data = true
    level                  = "ALL"
    log_destination        = "${aws_cloudwatch_log_group.updater.arn}:*"
  }

  tracing_configuration {
    enabled = true
  }

  definition = jsonencode({
    Comment = "Reconcile a customer-owned Kortix installation to signed stable metadata"
    StartAt = "Run signed updater"
    States = {
      "Run signed updater" = {
        Type     = "Task"
        Resource = "arn:aws:states:::codebuild:startBuild.sync"
        Parameters = {
          ProjectName = aws_codebuild_project.updater.name
          EnvironmentVariablesOverride = [{
            Name      = "KORTIX_EXECUTION_INPUT"
            Type      = "PLAINTEXT"
            "Value.$" = "States.JsonToString($)"
          }]
        }
        Retry = [{
          ErrorEquals     = ["CodeBuild.CodeBuildException", "States.TaskFailed"]
          IntervalSeconds = 30
          MaxAttempts     = 2
          BackoffRate     = 2
        }]
        End = true
      }
    }
  })

  tags = local.tags
}

data "aws_iam_policy_document" "events_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "events" {
  name                 = "${var.name}-reconcile-events"
  assume_role_policy   = data.aws_iam_policy_document.events_assume.json
  permissions_boundary = var.permissions_boundary_arn
  tags                 = local.tags
}

resource "aws_iam_role_policy" "events" {
  name = "${var.name}-start-reconcile"
  role = aws_iam_role.events.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "states:StartExecution"
      Resource = aws_sfn_state_machine.reconcile.arn
    }]
  })
}

resource "aws_cloudwatch_event_bus" "releases" {
  name = "${var.name}-releases"
  tags = local.tags
}

resource "aws_cloudwatch_event_permission" "publisher" {
  principal      = var.release_publisher_account_id
  statement_id   = "KortixReleaseHints"
  action         = "events:PutEvents"
  event_bus_name = aws_cloudwatch_event_bus.releases.name
}

resource "aws_cloudwatch_event_archive" "releases" {
  name             = "${var.name}-release-hints"
  event_source_arn = aws_cloudwatch_event_bus.releases.arn
  retention_days   = 30
}

resource "aws_cloudwatch_event_rule" "release_hint" {
  name           = "${var.name}-stable-hint"
  description    = "Untrusted wake-up hint; updater still verifies TUF metadata and artifact signatures"
  event_bus_name = aws_cloudwatch_event_bus.releases.name
  event_pattern = jsonencode({
    source        = ["com.kortix.enterprise.release"]
    "detail-type" = ["Kortix stable release"]
    detail = {
      channel = [var.release_channel]
    }
  })
  tags = local.tags
}

resource "aws_cloudwatch_event_target" "release_hint" {
  rule           = aws_cloudwatch_event_rule.release_hint.name
  event_bus_name = aws_cloudwatch_event_bus.releases.name
  arn            = aws_sfn_state_machine.reconcile.arn
  role_arn       = aws_iam_role.events.arn
}

resource "aws_cloudwatch_event_rule" "hourly" {
  name                = "${var.name}-hourly-reconcile"
  description         = "Source-of-truth backstop when release hints are delayed or missed"
  schedule_expression = "rate(1 hour)"
  tags                = local.tags
}

resource "aws_cloudwatch_event_target" "hourly" {
  rule     = aws_cloudwatch_event_rule.hourly.name
  arn      = aws_sfn_state_machine.reconcile.arn
  role_arn = aws_iam_role.events.arn
  input = jsonencode({
    trigger = "hourly"
    force   = false
  })
}
