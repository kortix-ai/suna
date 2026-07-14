# The appliance host: ONE public EC2 that runs the whole product as Docker
# containers (Caddy + api x2 + gateway + frontend + the official Supabase Docker
# stack). Caddy terminates TLS via ACME (DNS-01 through Route53) and owns the
# host/path routing the ALB used to own. The on-box updater (systemd timer)
# reconciles the signed stable release. No SSH; SSM is the only management path.

data "aws_subnet" "appliance" {
  id = module.network.public_subnet_ids[0]
}

resource "aws_security_group" "appliance" {
  #checkov:skip=CKV_AWS_260:Port 80 is the customer-facing HTTP surface (ACME HTTP-01 fallback + Caddy's HTTP->HTTPS redirect) and honors ingress_cidrs, which enterprise customers restrict to their networks.
  name_prefix = "${var.name}-appliance-"
  description = "Public Kortix appliance host; 80/443 from ingress_cidrs only, no SSH (SSM-managed)"
  vpc_id      = module.network.vpc_id

  ingress {
    description = "HTTP (Caddy redirect to HTTPS + ACME HTTP-01 fallback)"
    protocol    = "tcp"
    from_port   = 80
    to_port     = 80
    cidr_blocks = var.ingress_cidrs
  }

  ingress {
    description = "HTTPS (Caddy TLS termination for api/frontend/Supabase data plane)"
    protocol    = "tcp"
    from_port   = 443
    to_port     = 443
    cidr_blocks = var.ingress_cidrs
  }

  # The box pulls images (ECR/Docker Hub), signs Bedrock/Route53/AWS API calls,
  # runs ACME, and egresses to Daytona sandboxes — all over TLS.
  #trivy:ignore:AVD-AWS-0104
  egress {
    description = "TLS egress to AWS APIs, ECR, Bedrock, Route53, ACME, and sandbox providers"
    protocol    = "tcp"
    from_port   = 443
    to_port     = 443
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description = "DNS to the VPC resolver"
    protocol    = "udp"
    from_port   = 53
    to_port     = 53
    cidr_blocks = ["${cidrhost(var.vpc_cidr, 2)}/32"]
  }

  egress {
    description = "NTP time synchronization"
    protocol    = "udp"
    from_port   = 123
    to_port     = 123
    cidr_blocks = ["169.254.169.123/32"]
  }

  tags = merge(local.tags, { Name = "${var.name}-appliance" })
}

data "aws_iam_policy_document" "ec2_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "appliance" {
  name                 = "${var.name}-appliance"
  assume_role_policy   = data.aws_iam_policy_document.ec2_assume.json
  permissions_boundary = var.permissions_boundary_arn
  tags                 = local.tags
}

resource "aws_iam_role_policy_attachment" "appliance_ssm" {
  role       = aws_iam_role.appliance.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

# The instance profile replaces every ECS task/exec role: the containers and the
# on-box updater all run under it. Least-privilege, scoped to this installation.
data "aws_iam_policy_document" "appliance" {
  #checkov:skip=CKV_AWS_356:ecr:GetAuthorizationToken and cloudwatch:PutMetricData do not support resource-level ARNs (the latter is namespace-condition scoped); every other statement is scoped to this installation's secrets, keys, repos, bucket, zone, models, and SSM parameter.

  # api/migrate render .env from the runtime secret; the updater reads its
  # integration values from the updater secret.
  statement {
    sid = "ReadRuntimeSecrets"
    actions = [
      "secretsmanager:DescribeSecret",
      "secretsmanager:GetSecretValue",
    ]
    resources = [
      aws_secretsmanager_secret.runtime.arn,
      aws_secretsmanager_secret.updater.arn,
    ]
  }

  statement {
    sid = "UseCustomerKeys"
    actions = [
      "kms:Decrypt",
      "kms:DescribeKey",
      "kms:GenerateDataKey",
    ]
    resources = [aws_kms_key.data.arn, aws_kms_key.secrets.arn]
  }

  # Pull digest-pinned images from the customer ECR mirror (read only; the mirror
  # is populated by the signed release/promote pipeline, not from the box).
  statement {
    sid = "PullMirroredImages"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:DescribeImages",
      "ecr:GetDownloadUrlForLayer",
      "ecr:ListImages",
    ]
    resources = [for repository in aws_ecr_repository.enterprise : repository.arn]
  }

  statement {
    sid       = "EcrLogin"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  # The updater pulls the verified Supabase/app bundle tarballs staged in S3.
  statement {
    sid       = "ReadStagedReleaseArtifacts"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.artifacts.arn}/updater-staging/*"]
  }

  # The gateway resolves managed Claude models to Bedrock, SigV4-signing with the
  # instance role (no bearer key, no OpenRouter dependency).
  statement {
    sid = "InvokeBedrock"
    actions = [
      "bedrock:InvokeModel",
      "bedrock:InvokeModelWithResponseStream",
    ]
    resources = var.bedrock_model_allowlist
  }

  # ACME DNS-01: the updater writes _acme-challenge TXT records in the customer
  # zone so Caddy can issue certificates for api_domain + frontend_domain.
  statement {
    sid = "ManageAcmeAndAppDnsRecords"
    actions = [
      "route53:ChangeResourceRecordSets",
      "route53:ListResourceRecordSets",
    ]
    resources = [local.route53_zone_arn]
  }

  statement {
    sid       = "PollDnsChangeStatus"
    actions   = ["route53:GetChange"]
    resources = ["arn:${local.partition}:route53:::change/*"]
  }

  # The updater reads/writes the human-readable release breadcrumb.
  statement {
    sid = "ReadWriteReleaseBreadcrumb"
    actions = [
      "ssm:GetParameter",
      "ssm:PutParameter",
    ]
    resources = ["arn:${local.partition}:ssm:${local.region}:${var.expected_account_id}:parameter${local.release_ssm_param}"]
  }

  # The CloudWatch agent publishes data-volume disk metrics for the self-healing
  # alarm below.
  statement {
    sid       = "PublishHostMetrics"
    actions   = ["cloudwatch:PutMetricData"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "cloudwatch:namespace"
      values   = ["Kortix/${var.name}"]
    }
  }

  statement {
    sid = "WriteRuntimeLogs"
    actions = [
      "logs:CreateLogGroup",
      "logs:CreateLogStream",
      "logs:DescribeLogStreams",
      "logs:PutLogEvents",
    ]
    resources = ["arn:${local.partition}:logs:${local.region}:${var.expected_account_id}:log-group:/kortix/${var.name}/*"]
  }
}

resource "aws_iam_role_policy" "appliance" {
  name   = "${var.name}-appliance-runtime"
  role   = aws_iam_role.appliance.id
  policy = data.aws_iam_policy_document.appliance.json
}

resource "aws_iam_instance_profile" "appliance" {
  name = "${var.name}-appliance"
  role = aws_iam_role.appliance.name
  tags = local.tags
}

# Persistent, encrypted data volume (Postgres + storage). prevent_destroy and
# AWS Backup (backup.tf) are unchanged from the original design.
resource "aws_ebs_volume" "supabase_data" {
  availability_zone    = data.aws_subnet.appliance.availability_zone
  encrypted            = true
  kms_key_id           = aws_kms_key.data.arn
  type                 = "gp3"
  size                 = var.data_volume_size_gib
  iops                 = var.data_volume_iops
  throughput           = var.data_volume_throughput
  multi_attach_enabled = false

  tags = merge(local.tags, {
    Name       = "${var.name}-appliance-data"
    BackupTier = "hourly-snapshot"
  })

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_cloudwatch_log_group" "appliance" {
  name              = "/kortix/${var.name}/appliance"
  retention_in_days = 365
  kms_key_id        = aws_kms_key.data.arn
  tags              = local.tags
}

# Human-readable breadcrumb of the currently reconciled release (never a lock).
# The on-box updater owns the value.
resource "aws_ssm_parameter" "release" {
  #checkov:skip=CKV_AWS_337:The breadcrumb holds only public release metadata (version + image digests); the AWS-managed aws/ssm key avoids KeyId drift between Terraform and the updater's overwrite calls.
  name        = local.release_ssm_param
  description = "Currently reconciled Kortix stable release for ${var.name}. Written by the on-box updater; never a lock."
  type        = "SecureString"
  value       = "unset"
  tier        = "Standard"

  lifecycle {
    ignore_changes = [value]
  }

  tags = local.tags
}

resource "aws_instance" "appliance" {
  #checkov:skip=CKV_AWS_88:Public exposure is the product — this single box is the customer-facing edge (Caddy terminates TLS on 80/443). Reach is governed by the appliance security group (ingress_cidrs only); there is no SSH and management is SSM-only.
  ami                         = local.appliance_ami
  instance_type               = var.appliance_instance_type
  subnet_id                   = data.aws_subnet.appliance.id
  vpc_security_group_ids      = [aws_security_group.appliance.id]
  iam_instance_profile        = aws_iam_instance_profile.appliance.name
  associate_public_ip_address = true
  monitoring                  = true
  ebs_optimized               = true
  disable_api_termination     = var.protect_from_destroy
  user_data_replace_on_change = false

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
    instance_metadata_tags      = "enabled"
  }

  root_block_device {
    encrypted             = true
    kms_key_id            = aws_kms_key.data.arn
    volume_type           = "gp3"
    volume_size           = var.root_volume_size_gib
    delete_on_termination = true
  }

  user_data = templatefile("${path.module}/files/supabase-user-data.sh.tftpl", {
    aws_region             = local.region
    data_volume_id         = aws_ebs_volume.supabase_data.id
    instance_name          = var.name
    expected_account_id    = var.expected_account_id
    runtime_secret_arn     = aws_secretsmanager_secret.runtime.arn
    updater_secret_arn     = aws_secretsmanager_secret.updater.arn
    log_group              = aws_cloudwatch_log_group.appliance.name
    metric_namespace       = "Kortix/${var.name}"
    release_channel        = var.release_channel
    release_repository_url = var.release_repository_url
    tuf_root_sha256        = var.tuf_root_sha256
    maintenance_window     = var.maintenance_window
    release_ssm_param      = local.release_ssm_param
    artifact_bucket        = aws_s3_bucket.artifacts.bucket
    api_domain             = var.api_domain
    frontend_domain        = var.frontend_domain
    acme_email             = var.acme_email
    route53_zone_id        = var.route53_zone_id
    ecr_repositories       = jsonencode({ for name, repository in aws_ecr_repository.enterprise : name => repository.repository_url })
  })

  tags = merge(local.tags, {
    Name = "${var.name}-appliance"
  })

  depends_on = [
    aws_iam_role_policy.appliance,
    aws_vpc_endpoint.interface,
    aws_vpc_endpoint.s3,
  ]
}

# Stable public address the app A records and customer allowlists pin to.
resource "aws_eip" "appliance" {
  domain   = "vpc"
  instance = aws_instance.appliance.id
  tags     = merge(local.tags, { Name = "${var.name}-appliance" })

  depends_on = [module.network]
}

resource "aws_volume_attachment" "supabase_data" {
  device_name                    = "/dev/sdf"
  volume_id                      = aws_ebs_volume.supabase_data.id
  instance_id                    = aws_instance.appliance.id
  force_detach                   = false
  stop_instance_before_detaching = true
}

# ── DNS (collapsed here from the old platform stage; A records -> the EIP) ─────
# EIPs are IPv4-only, so v1 publishes A records only. AAAA is deferred until the
# VPC/host carry IPv6 (documented v1 limitation; Caddy still serves both domains).
data "aws_route53_zone" "public" {
  zone_id      = var.route53_zone_id
  private_zone = false
}

locals {
  public_zone_name = lower(trimsuffix(data.aws_route53_zone.public.name, "."))
  app_domains      = toset([var.api_domain, var.frontend_domain])
}

resource "terraform_data" "public_dns_guard" {
  input = {
    zone     = data.aws_route53_zone.public.name
    api      = var.api_domain
    frontend = var.frontend_domain
  }

  lifecycle {
    precondition {
      condition = alltrue([for domain in [var.api_domain, var.frontend_domain] :
        lower(domain) == local.public_zone_name || endswith(lower(domain), ".${local.public_zone_name}")
      ])
      error_message = "api_domain and frontend_domain must both belong to route53_zone_id."
    }
  }
}

resource "aws_route53_record" "app" {
  for_each = local.app_domains

  zone_id = data.aws_route53_zone.public.zone_id
  name    = each.value
  type    = "A"
  ttl     = 60
  records = [aws_eip.appliance.public_ip]

  depends_on = [terraform_data.public_dns_guard]
}

# ── Self-healing ──────────────────────────────────────────────────────────────
# EC2 auto-recovery on an underlying host/system failure (unchanged intent).
resource "aws_cloudwatch_metric_alarm" "appliance_recover" {
  alarm_name          = "${var.name}-appliance-system-recovery"
  alarm_description   = "Recover the appliance host on underlying EC2 system failure"
  namespace           = "AWS/EC2"
  metric_name         = "StatusCheckFailed_System"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "breaching"
  dimensions = {
    InstanceId = aws_instance.appliance.id
  }
  alarm_actions = ["arn:${local.partition}:automate:${local.region}:ec2:recover"]
  tags          = local.tags
}

# Instance status-check failures (guest OS / networking wedged) — visible alarm,
# no pager wiring in v1.
resource "aws_cloudwatch_metric_alarm" "appliance_instance_status" {
  alarm_name          = "${var.name}-appliance-instance-status"
  alarm_description   = "Appliance guest instance status check failing (OS/network); investigate"
  namespace           = "AWS/EC2"
  metric_name         = "StatusCheckFailed_Instance"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "breaching"
  dimensions = {
    InstanceId = aws_instance.appliance.id
  }
  tags = local.tags
}

# Data-volume fill-up — the CloudWatch agent publishes disk_used_percent for the
# /var/lib/kortix mount, aggregated on InstanceId (single monitored path), into
# the Kortix/<instance> namespace.
resource "aws_cloudwatch_metric_alarm" "appliance_disk" {
  alarm_name          = "${var.name}-appliance-data-disk"
  alarm_description   = "Appliance data volume ${var.disk_used_percent_alarm_threshold}%+ full; prune images or grow the volume"
  namespace           = "Kortix/${var.name}"
  metric_name         = "disk_used_percent"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  threshold           = var.disk_used_percent_alarm_threshold
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "missing"
  dimensions = {
    InstanceId = aws_instance.appliance.id
  }
  tags = local.tags
}
