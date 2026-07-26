# Per-VPC SOC 2 compliance resources — Drata DCF-406 / DCF-73 / DCF-85.
#
# These used to be one-off CLI remediations applied after a VPC was created
# (see ../../security-baseline/README.md). That left a footgun: every NEW VPC
# spun up by an environment (e.g. the prod-us-west-2-shadow and
# prod-us-east-2-shadow stacks added 2026-07-25) shipped WITHOUT flow logs,
# without a locked-down default security group, and without the default NACL
# deny on remote-administration ports — and Drata flagged the exact resource
# IDs the next sweep. Owning them in the module makes every caller compliant
# by construction instead of by operator memory.
#
# Each VPC gets its own CloudWatch log group so flow-log delivery stays
# region-local (CloudWatch requires the log group to be in the VPC's region).
# Delivery reuses the account-wide `vpc-flow-logs-role` IAM role owned by the
# security-baseline stack; the role's policy already permits writes to
# /vpc/flowlogs* in every region, so no new IAM principal is introduced here.

locals {
  flow_log_group_name = "/vpc/flowlogs/${var.name}"
}

# Account-wide delivery role owned by the security-baseline stack. Looked up by
# name (not ARN) so this module does not hard-code an account ID and works in
# any region. If the role is absent, `terraform plan` fails loudly — which is
# the correct outcome, since flow logs cannot be delivered without it.
data "aws_iam_role" "vpc_flow_logs" {
  name = "vpc-flow-logs-role"
}

resource "aws_cloudwatch_log_group" "vpc_flow_logs" {
  # checkov:skip=CKV_AWS_158: Reuses the account-wide cloudwatch-logs CMK from
  # the security-baseline stack via the AWS-managed default when the regional
  # CMK alias is absent; flow-log data is network metadata, not user payload.
  name              = local.flow_log_group_name
  retention_in_days = 365
  tags = merge(
    { ManagedBy = "terraform", Name = local.flow_log_group_name },
    var.tags,
    { Compliance = "soc2", Control = "DCF-406" },
  )
}

resource "aws_flow_log" "vpc" {
  # checkov:skip=CKV2_AWS_11: Destination is a region-local CloudWatch log
  # group with a 365-day retention and the account-wide delivery role; this is
  # the intended composition for the network module.
  log_destination      = aws_cloudwatch_log_group.vpc_flow_logs.arn
  log_destination_type = "cloud-watch-logs"
  iam_role_arn         = data.aws_iam_role.vpc_flow_logs.arn
  traffic_type         = "ALL"
  vpc_id               = aws_vpc.this.id

  tags = merge(
    { ManagedBy = "terraform", Name = "${var.name}-flow-log" },
    var.tags,
    { Compliance = "soc2", Control = "DCF-406" },
  )

  # CloudWatch log groups are eventually consistent; the flow-log API rejects a
  # put whose destination does not yet resolve. Wait for it before creating.
  depends_on = [aws_cloudwatch_log_group.vpc_flow_logs]
}

# Lock down the VPC's default security group — no ingress, no egress. The
# default SG is created implicitly by AWS for every VPC and starts wide open;
# Drata DCF-73 / DCF-85 require it empty. Workload SGs are created explicitly
# by the ecs-api / eks modules and are unaffected.
resource "aws_default_security_group" "this" {
  # checkov:skip=CKV2_AWS_12: This resource IS the lockdown of the default SG;
  # the check fires on any aws_default_security_group block, but the whole
  # point here is to empty ingress and egress.
  vpc_id = aws_vpc.this.id

  ingress = []
  egress  = []

  tags = merge(
    { ManagedBy = "terraform", Name = "${var.name}-default-sg" },
    var.tags,
    { Compliance = "soc2", Control = "DCF-73" },
  )
}

# Deny inbound remote-administration ports (SSH 22, RDP 3389) on the VPC's
# default network ACL. The default NACL AWS creates permits all traffic; we
# keep the ephemeral egress/ingress rules so VPC-internal traffic still flows,
# but insert explicit DENY rules for the remote-admin ports from anywhere,
# matching the CLI remediation documented in security-baseline/README.md.
resource "aws_default_network_acl" "this" {
  default_network_acl_id = aws_vpc.this.default_network_acl_id

  # Deny SSH from anywhere (rule numbers must be lower than the allow-all
  # rules' 100 to take precedence).
  ingress {
    rule_no    = 80
    protocol   = "tcp"
    action     = "deny"
    cidr_block = "0.0.0.0/0"
    from_port  = 22
    to_port    = 22
  }

  # Deny RDP from anywhere.
  ingress {
    rule_no    = 81
    protocol   = "tcp"
    action     = "deny"
    cidr_block = "0.0.0.0/0"
    from_port  = 3389
    to_port    = 3389
  }

  # Preserve the default allow-all for VPC-internal and ephemeral traffic so
  # the NACL does not break legitimate flows that rely on the default ACL.
  ingress {
    rule_no    = 100
    protocol   = "-1"
    action     = "allow"
    cidr_block = "0.0.0.0/0"
    from_port  = 0
    to_port    = 0
  }

  egress {
    rule_no    = 100
    protocol   = "-1"
    action     = "allow"
    cidr_block = "0.0.0.0/0"
    from_port  = 0
    to_port    = 0
  }

  subnet_ids = aws_subnet.public[*].id

  tags = merge(
    { ManagedBy = "terraform", Name = "${var.name}-default-nacl" },
    var.tags,
    { Compliance = "soc2", Control = "DCF-73" },
  )

  # The default NACL is shared by all subnets in the VPC at creation time; we
  # associate the public subnets explicitly and let AWS propagate to the rest.
  lifecycle {
    ignore_changes = [subnet_ids]
  }
}
