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

  # Keep composed tag maps behind named locals. This preserves every caller and
  # resource-specific tag while allowing static IaC scanners to recognize that
  # each resource has a tag assignment instead of treating merge(...) as {}.
  vpc_tags              = merge({ ManagedBy = "terraform" }, var.tags, var.extra_vpc_tags, { Name = "${var.name}-vpc" })
  internet_gateway_tags = merge({ ManagedBy = "terraform" }, var.tags, { Name = "${var.name}-igw" })
  public_subnet_tags = [for i in range(var.az_count) : merge(
    { ManagedBy = "terraform" },
    var.tags,
    var.extra_public_subnet_tags,
    { Name = "${var.name}-public-${local.azs[i]}", Tier = "public" },
  )]
  public_route_table_tags = merge({ ManagedBy = "terraform" }, var.tags, { Name = "${var.name}-public-rt" })
  private_subnet_tags = [for i in range(var.az_count) : merge(
    { ManagedBy = "terraform" },
    var.tags,
    var.extra_private_subnet_tags,
    { Name = "${var.name}-private-${local.azs[i]}", Tier = "private" },
  )]
  nat_eip_tags = [for i in range(local.nat_count) : merge(
    { ManagedBy = "terraform" }, var.tags, { Name = "${var.name}-nat-eip-${i}" },
  )]
  nat_gateway_tags = [for i in range(local.nat_count) : merge(
    { ManagedBy = "terraform" }, var.tags, { Name = "${var.name}-nat-${i}" },
  )]
  private_route_table_tags = [for i in range(var.az_count) : merge(
    { ManagedBy = "terraform" }, var.tags, { Name = "${var.name}-private-rt-${i}" },
  )]
  default_network_acl_tags = merge({ ManagedBy = "terraform" }, var.tags, { Name = "${var.name}-default-nacl" })
}

resource "aws_vpc" "this" {
  #checkov:skip=CKV2_AWS_11:Flow-log destination, KMS key, and retention are deployment concerns composed by production callers; enterprise-vpc creates aws_flow_log.vpc with 60-second aggregation.
  #checkov:skip=CKV2_AWS_12:The enterprise-vpc caller owns the VPC default security group and empties ingress and egress; keeping it outside this shared module avoids duplicate aws_default_security_group ownership.
  cidr_block           = var.cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = local.vpc_tags
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
  tags   = local.internet_gateway_tags
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
  tags                    = local.public_subnet_tags[count.index]
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.this.id
  }
  tags = local.public_route_table_tags
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
  tags              = local.private_subnet_tags[count.index]
}

# Explicitly manage the VPC's default network ACL instead of inheriting AWS's
# allow-all default. VPC-internal traffic remains unrestricted, while internet
# ingress is limited to web traffic, return-path ephemeral ports, and ICMP.
# The split ephemeral ranges deliberately exclude RDP (3389); SSH (22) is not
# exposed at all.
resource "aws_default_network_acl" "this" {
  default_network_acl_id = aws_vpc.this.default_network_acl_id

  ingress {
    protocol   = "-1"
    rule_no    = 1
    action     = "allow"
    cidr_block = var.cidr
    from_port  = 0
    to_port    = 0
  }

  ingress {
    protocol   = "tcp"
    rule_no    = 110
    action     = "allow"
    cidr_block = "0.0.0.0/0"
    from_port  = 80
    to_port    = 80
  }

  ingress {
    protocol   = "tcp"
    rule_no    = 120
    action     = "allow"
    cidr_block = "0.0.0.0/0"
    from_port  = 443
    to_port    = 443
  }

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
    protocol   = "-1"
    rule_no    = 100
    action     = "allow"
    cidr_block = "0.0.0.0/0"
    from_port  = 0
    to_port    = 0
  }

  tags = local.default_network_acl_tags
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
  tags = local.private_route_table_tags[count.index]
}

resource "aws_route_table_association" "private" {
  count          = var.az_count
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private[count.index].id
}
