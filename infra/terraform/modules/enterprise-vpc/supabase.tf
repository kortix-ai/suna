data "aws_subnet" "supabase" {
  id = module.network.private_subnet_ids[0]
}

resource "aws_security_group" "supabase" {
  name_prefix = "${var.name}-supabase-"
  description = "Private Supabase Docker host; no public or SSH ingress"
  vpc_id      = module.network.vpc_id

  ingress {
    description     = "Supabase Kong from EKS workloads"
    protocol        = "tcp"
    from_port       = 8000
    to_port         = 8000
    security_groups = [module.eks.cluster_security_group_id]
  }

  ingress {
    description     = "Postgres migrations and runtime access from EKS"
    protocol        = "tcp"
    from_port       = 5432
    to_port         = 5432
    security_groups = [module.eks.cluster_security_group_id]
  }

  egress {
    description = "TLS-only connected-tier egress"
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

  tags = merge(local.tags, { Name = "${var.name}-supabase" })
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

resource "aws_iam_role" "supabase" {
  name                 = "${var.name}-supabase"
  assume_role_policy   = data.aws_iam_policy_document.ec2_assume.json
  permissions_boundary = var.permissions_boundary_arn
  tags                 = local.tags
}

resource "aws_iam_role_policy_attachment" "supabase_ssm" {
  role       = aws_iam_role.supabase.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

data "aws_iam_policy_document" "supabase" {
  statement {
    sid = "ReadRuntimeSecret"
    actions = [
      "secretsmanager:DescribeSecret",
      "secretsmanager:GetSecretValue",
    ]
    resources = [aws_secretsmanager_secret.runtime.arn]
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

  statement {
    sid = "BackupAndReleaseObjects"
    actions = [
      "s3:AbortMultipartUpload",
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:ListBucket",
      "s3:PutObject",
    ]
    resources = [
      aws_s3_bucket.backups.arn,
      "${aws_s3_bucket.backups.arn}/*",
      aws_s3_bucket.release_cache.arn,
      "${aws_s3_bucket.release_cache.arn}/*",
    ]
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

resource "aws_iam_role_policy" "supabase" {
  name   = "${var.name}-supabase-runtime"
  role   = aws_iam_role.supabase.id
  policy = data.aws_iam_policy_document.supabase.json
}

resource "aws_iam_instance_profile" "supabase" {
  name = "${var.name}-supabase"
  role = aws_iam_role.supabase.name
  tags = local.tags
}

resource "aws_ebs_volume" "supabase_data" {
  availability_zone    = data.aws_subnet.supabase.availability_zone
  encrypted            = true
  kms_key_id           = aws_kms_key.data.arn
  type                 = "gp3"
  size                 = var.supabase_data_volume_size_gib
  iops                 = var.supabase_data_volume_iops
  throughput           = var.supabase_data_volume_throughput
  multi_attach_enabled = false

  tags = merge(local.tags, {
    Name       = "${var.name}-supabase-data"
    BackupTier = "continuous-wal-plus-hourly-snapshot"
  })

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_cloudwatch_log_group" "supabase" {
  name              = "/kortix/${var.name}/supabase"
  retention_in_days = 365
  kms_key_id        = aws_kms_key.data.arn
  tags              = local.tags
}

resource "aws_instance" "supabase" {
  ami                         = local.supabase_ami
  instance_type               = var.supabase_instance_type
  subnet_id                   = data.aws_subnet.supabase.id
  vpc_security_group_ids      = [aws_security_group.supabase.id]
  iam_instance_profile        = aws_iam_instance_profile.supabase.name
  associate_public_ip_address = false
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
    volume_size           = 50
    delete_on_termination = true
  }

  user_data = templatefile("${path.module}/files/supabase-user-data.sh.tftpl", {
    aws_region           = local.region
    data_volume_id       = aws_ebs_volume.supabase_data.id
    instance_name        = var.name
    runtime_secret_arn   = aws_secretsmanager_secret.runtime.arn
    backup_bucket        = aws_s3_bucket.backups.id
    release_cache_bucket = aws_s3_bucket.release_cache.id
    log_group            = aws_cloudwatch_log_group.supabase.name
  })

  tags = merge(local.tags, {
    Name = "${var.name}-supabase"
  })

  depends_on = [
    aws_iam_role_policy.supabase,
    aws_vpc_endpoint.interface,
    aws_vpc_endpoint.s3,
  ]
}

resource "aws_volume_attachment" "supabase_data" {
  device_name                    = "/dev/sdf"
  volume_id                      = aws_ebs_volume.supabase_data.id
  instance_id                    = aws_instance.supabase.id
  force_detach                   = false
  stop_instance_before_detaching = true
}

resource "aws_cloudwatch_metric_alarm" "supabase_recover" {
  alarm_name          = "${var.name}-supabase-system-recovery"
  alarm_description   = "Recover the Supabase host on underlying EC2 system failure"
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
    InstanceId = aws_instance.supabase.id
  }
  alarm_actions = ["arn:${local.partition}:automate:${local.region}:ec2:recover"]
  tags          = local.tags
}
