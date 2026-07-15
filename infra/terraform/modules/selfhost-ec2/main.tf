# selfhost-ec2 — a thin, optional convenience provisioner for `kortix
# self-host`. This is NOT a parallel deployment system: Terraform provisions
# the box exactly once (instance + data volume + security group + DNS), and
# cloud-init runs the exact same `kortix self-host init` / `start` any
# self-host user runs by hand. After that, the box keeps itself current via
# the in-compose nightly `kortix-updater` service — re-running `terraform
# apply` does not redeploy the app, and there is no Terraform-side update
# path to keep in sync with it.

locals {
  name = var.name

  # Route53 record for the API subdomain — defaults to api.<domain>, matching
  # the kortix CLI's own default (KORTIX_API_DOMAIN), so this is normally left
  # unset.
  api_domain = var.api_domain != "" ? var.api_domain : "api.${var.domain}"

  ami_id = var.ami_id != "" ? var.ami_id : data.aws_ssm_parameter.ubuntu[0].value

  vpc_id    = var.vpc_id != "" ? var.vpc_id : data.aws_vpc.default[0].id
  subnet_id = var.subnet_id != "" ? var.subnet_id : data.aws_subnets.default[0].ids[0]

  tags = merge(var.tags, {
    Name      = local.name
    ManagedBy = "terraform"
    Module    = "selfhost-ec2"
  })
}

# ── AMI (Ubuntu 24.04 LTS via Canonical's public SSM parameter) ────────────
data "aws_ssm_parameter" "ubuntu" {
  count = var.ami_id == "" ? 1 : 0
  name  = var.ami_ssm_parameter
}

# ── Default VPC / subnet fallback (bring-your-own is preferred; this keeps
#    the module deployable in a stock account with zero network inputs) ─────
data "aws_vpc" "default" {
  count   = var.vpc_id == "" ? 1 : 0
  default = true
}

data "aws_subnets" "default" {
  count = var.vpc_id == "" || var.subnet_id == "" ? 1 : 0
  filter {
    name   = "vpc-id"
    values = [local.vpc_id]
  }
  filter {
    name   = "default-for-az"
    values = ["true"]
  }
}

# ── Security group: 80 (ACME) + 443 (app) in, all out ──────────────────────
resource "aws_security_group" "this" {
  #checkov:skip=CKV_AWS_24:SSH ingress is opt-in only (empty by default — dynamic block below only exists when var.ssh_ingress_cidrs is set); SSM Session Manager (AmazonSSMManagedInstanceCore on the instance profile) is the supported no-open-port path.
  #checkov:skip=CKV_AWS_382:this is a general-purpose self-host box, not an internal service — it needs outbound to Docker Hub/GHCR (image pulls + the in-compose updater), GitHub Releases (CLI install/update), ACME servers, apt/package mirrors, and whatever a sandboxed build reaches; there is no fixed egress allowlist to scope this to.
  name        = "${local.name}-sg"
  description = "kortix self-host box: 80/443 in, all out"
  vpc_id      = local.vpc_id

  ingress {
    description = "HTTP (ACME HTTP-01)"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = var.allowed_cidrs
  }

  ingress {
    description = "HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = var.allowed_cidrs
  }

  dynamic "ingress" {
    for_each = length(var.ssh_ingress_cidrs) > 0 ? [1] : []
    content {
      description = "SSH (optional — SSM Session Manager needs no open port)"
      from_port   = 22
      to_port     = 22
      protocol    = "tcp"
      cidr_blocks = var.ssh_ingress_cidrs
    }
  }

  egress {
    description = "All outbound (image pulls, ACME, Daytona API, etc.)"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = local.tags
}

# ── IAM: SSM Session Manager only — no SSH key required to administer ─────
data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "this" {
  name               = "${local.name}-role"
  assume_role_policy = data.aws_iam_policy_document.assume.json
  tags               = local.tags
}

resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.this.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "this" {
  name = "${local.name}-profile"
  role = aws_iam_role.this.name
  tags = local.tags
}

# ── Instance ────────────────────────────────────────────────────────────────
resource "aws_instance" "this" {
  ami                    = local.ami_id
  instance_type          = var.instance_type
  subnet_id              = local.subnet_id
  vpc_security_group_ids = [aws_security_group.this.id]
  iam_instance_profile   = aws_iam_instance_profile.this.name
  key_name               = var.key_name != "" ? var.key_name : null
  ebs_optimized          = true
  monitoring             = true

  # IMDSv2 only.
  metadata_options {
    http_tokens                 = "required"
    http_endpoint               = "enabled"
    http_put_response_hop_limit = 2
  }

  root_block_device {
    volume_type           = "gp3"
    volume_size           = var.root_volume_size_gb
    encrypted             = true
    delete_on_termination = true
    tags                  = merge(local.tags, { Name = "${local.name}-root" })
  }

  user_data = templatefile("${path.module}/templates/user-data.sh.tftpl", {
    domain                  = var.domain
    api_domain              = local.api_domain
    instance_name           = var.instance_name
    kortix_channel          = var.kortix_channel
    kortix_version          = var.kortix_version
    kortix_cli_install_url  = var.kortix_cli_install_url
    kortix_cli_channel      = var.kortix_cli_channel
    auto_update             = var.auto_update
    single_account_mode     = var.single_account_mode
    admin_email             = var.admin_email
    acme_email              = var.acme_email
    data_volume_device_name = local.data_volume_device_name
    data_mount_path         = local.data_mount_path
  })
  user_data_replace_on_change = false

  tags = local.tags

  # The data volume is attached out-of-band (aws_volume_attachment below) and
  # deliberately NOT recreated when the instance is (delete_on_termination =
  # false on the volume) — an instance replacement must not touch it.
  lifecycle {
    ignore_changes = [ami]
  }
}
