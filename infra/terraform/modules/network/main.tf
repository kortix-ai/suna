# Reusable VPC for the Kortix API: public subnets (ALB + NAT) and private
# subnets (Fargate tasks) across N availability zones. Identical for dev and
# prod — only CIDR / az_count / single_nat_gateway differ via variables.

terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0"
    }
  }
}

data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  azs = slice(data.aws_availability_zones.available.names, 0, var.az_count)
  # /20 public + /20 private per AZ carved out of the VPC /16.
  public_subnets  = [for i in range(var.az_count) : cidrsubnet(var.cidr, 4, i)]
  private_subnets = [for i in range(var.az_count) : cidrsubnet(var.cidr, 4, i + 8)]
  # One NAT in dev (cost), one-per-AZ in prod (HA) — controlled by single_nat_gateway.
  nat_count = var.single_nat_gateway ? 1 : var.az_count

  # Non-inventory resources can keep composed maps here. Inventory resources
  # use explicit maps at the resource boundary so static compliance analysis
  # can verify their required tags without evaluating locals or merge().
  internet_gateway_tags = merge({ ManagedBy = "terraform" }, var.tags, { Name = "${var.name}-igw" })
  nat_eip_tags = [for i in range(local.nat_count) : merge(
    { ManagedBy = "terraform" }, var.tags, { Name = "${var.name}-nat-eip-${i}" },
  )]
  nat_gateway_tags = [for i in range(local.nat_count) : merge(
    { ManagedBy = "terraform" }, var.tags, { Name = "${var.name}-nat-${i}" },
  )]
}

resource "aws_vpc" "this" {
  #checkov:skip=CKV2_AWS_11:Flow-log destination, KMS key, and retention are deployment concerns composed by production callers; enterprise-vpc creates aws_flow_log.vpc with 60-second aggregation.
  #checkov:skip=CKV2_AWS_12:The enterprise-vpc caller owns the VPC default security group and empties ingress and egress; keeping it outside this shared module avoids duplicate aws_default_security_group ownership.
  cidr_block           = var.cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags = {
    ManagedBy                           = "terraform"
    Name                                = "${var.name}-vpc"
    Environment                         = lookup(var.tags, "Environment", "managed")
    Project                             = lookup(var.tags, "Project", "kortix")
    Service                             = lookup(var.tags, "Service", var.name)
    Platform                            = lookup(var.tags, "Platform", "network")
    "kubernetes.io/cluster/${var.name}" = lookup(var.extra_vpc_tags, "kubernetes.io/cluster/${var.name}", null)
  }
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
  tags   = local.internet_gateway_tags
}

# ── Default network ACL baseline ──────────────────────────────────────────────
# Public TCP/UDP is allowed as 1024-3388 + 3390-65535 rather than 1024-65535, so
# RDP (3389) is excluded; SSH (22) sits below 1024 and is excluded by the
# ephemeral floor. Rule numbers match the ACLs already deployed in every region
# so adopting an existing VPC is a no-op rather than a rewrite. Return traffic
# still flows because NACLs are stateless and ephemeral source ports land inside
# the permitted ranges.
resource "aws_default_network_acl" "this" {
  count = var.manage_default_network_acl ? 1 : 0

  default_network_acl_id = aws_vpc.this.default_network_acl_id

  # Unrestricted traffic inside the VPC.
  ingress {
    protocol   = -1
    rule_no    = 1
    action     = "allow"
    cidr_block = aws_vpc.this.cidr_block
    from_port  = 0
    to_port    = 0
  }

  # Individually published public TCP ports (80/443 by default).
  dynamic "ingress" {
    for_each = { for i, p in var.public_ingress_tcp_ports : i => p }
    content {
      protocol   = "tcp"
      rule_no    = 110 + (ingress.key * 10)
      action     = "allow"
      cidr_block = "0.0.0.0/0"
      from_port  = ingress.value
      to_port    = ingress.value
    }
  }

  # Ephemeral return ranges, split around RDP (3389).
  ingress {
    protocol   = "tcp"
    rule_no    = 130
    action     = "allow"
    cidr_block = "0.0.0.0/0"
    from_port  = 1024
    to_port    = 3388
  }
  ingress {
    protocol   = "tcp"
    rule_no    = 140
    action     = "allow"
    cidr_block = "0.0.0.0/0"
    from_port  = 3390
    to_port    = 65535
  }
  ingress {
    protocol   = "udp"
    rule_no    = 150
    action     = "allow"
    cidr_block = "0.0.0.0/0"
    from_port  = 1024
    to_port    = 3388
  }
  ingress {
    protocol   = "udp"
    rule_no    = 160
    action     = "allow"
    cidr_block = "0.0.0.0/0"
    from_port  = 3390
    to_port    = 65535
  }
  ingress {
    protocol   = "icmp"
    rule_no    = 170
    action     = "allow"
    cidr_block = "0.0.0.0/0"
    from_port  = 0
    to_port    = 0
    icmp_type  = -1
    icmp_code  = -1
  }

  egress {
    protocol   = -1
    rule_no    = 100
    action     = "allow"
    cidr_block = "0.0.0.0/0"
    from_port  = 0
    to_port    = 0
  }

  tags = merge({ ManagedBy = "terraform" }, var.tags, { Name = "${var.name}-default-nacl" })

  # Subnet membership follows subnet creation/deletion, not this resource.
  lifecycle {
    ignore_changes = [subnet_ids]
  }
}

# ── Public subnets ────────────────────────────────────────────────────────────
resource "aws_subnet" "public" {
  count             = var.az_count
  vpc_id            = aws_vpc.this.id
  cidr_block        = local.public_subnets[count.index]
  availability_zone = local.azs[count.index]
  # Public subnets host managed load balancers and NAT gateways; neither needs
  # arbitrary instances to receive a public IP by default.
  map_public_ip_on_launch = false
  tags = {
    ManagedBy                           = "terraform"
    Name                                = "${var.name}-public-${local.azs[count.index]}"
    Environment                         = lookup(var.tags, "Environment", "managed")
    Project                             = lookup(var.tags, "Project", "kortix")
    Service                             = lookup(var.tags, "Service", var.name)
    Platform                            = lookup(var.tags, "Platform", "network")
    Tier                                = "public"
    "kubernetes.io/role/elb"            = lookup(var.extra_public_subnet_tags, "kubernetes.io/role/elb", null)
    "kubernetes.io/cluster/${var.name}" = lookup(var.extra_public_subnet_tags, "kubernetes.io/cluster/${var.name}", null)
  }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.this.id
  }
  tags = {
    ManagedBy   = "terraform"
    Name        = "${var.name}-public-rt"
    Environment = lookup(var.tags, "Environment", "managed")
    Project     = lookup(var.tags, "Project", "kortix")
    Service     = lookup(var.tags, "Service", var.name)
    Platform    = lookup(var.tags, "Platform", "network")
    Tier        = "public"
  }
}

resource "aws_route_table_association" "public" {
  count          = var.az_count
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# ── Private subnets (egress via NAT) ──────────────────────────────────────────
resource "aws_subnet" "private" {
  count             = var.az_count
  vpc_id            = aws_vpc.this.id
  cidr_block        = local.private_subnets[count.index]
  availability_zone = local.azs[count.index]
  tags = {
    ManagedBy                           = "terraform"
    Name                                = "${var.name}-private-${local.azs[count.index]}"
    Environment                         = lookup(var.tags, "Environment", "managed")
    Project                             = lookup(var.tags, "Project", "kortix")
    Service                             = lookup(var.tags, "Service", var.name)
    Platform                            = lookup(var.tags, "Platform", "network")
    Tier                                = "private"
    "kubernetes.io/role/internal-elb"   = lookup(var.extra_private_subnet_tags, "kubernetes.io/role/internal-elb", null)
    "kubernetes.io/cluster/${var.name}" = lookup(var.extra_private_subnet_tags, "kubernetes.io/cluster/${var.name}", null)
  }
}

resource "aws_eip" "nat" {
  count  = local.nat_count
  domain = "vpc"
  tags   = local.nat_eip_tags[count.index]
}

resource "aws_nat_gateway" "this" {
  count         = local.nat_count
  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[count.index].id
  tags          = local.nat_gateway_tags[count.index]
  depends_on    = [aws_internet_gateway.this]
}

resource "aws_route_table" "private" {
  count  = var.az_count
  vpc_id = aws_vpc.this.id
  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.this[var.single_nat_gateway ? 0 : count.index].id
  }
  tags = {
    ManagedBy   = "terraform"
    Name        = "${var.name}-private-rt-${count.index}"
    Environment = lookup(var.tags, "Environment", "managed")
    Project     = lookup(var.tags, "Project", "kortix")
    Service     = lookup(var.tags, "Service", var.name)
    Platform    = lookup(var.tags, "Platform", "network")
    Tier        = "private"
  }
}

resource "aws_route_table_association" "private" {
  count          = var.az_count
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private[count.index].id
}
