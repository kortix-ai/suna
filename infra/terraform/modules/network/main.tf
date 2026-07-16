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
  public_subnet_tags = [for i in range(var.az_count) : merge(
    { ManagedBy = "terraform" },
    var.tags,
    var.extra_public_subnet_tags,
    { Name = "${var.name}-public-${local.azs[i]}", Tier = "public" },
  )]
  public_subnet_tag_assignments = merge([for i in range(var.az_count) : {
    for key, value in local.public_subnet_tags[i] : "${i}:${key}" => {
      subnet_index = i
      key          = key
      value        = value
    }
  }]...)
  nat_eip_tags = [for i in range(local.nat_count) : merge(
    { ManagedBy = "terraform" }, var.tags, { Name = "${var.name}-nat-eip-${i}" },
  )]
  nat_gateway_tags = [for i in range(local.nat_count) : merge(
    { ManagedBy = "terraform" }, var.tags, { Name = "${var.name}-nat-${i}" },
  )]
  private_subnet_tags = [for i in range(var.az_count) : merge(
    { ManagedBy = "terraform" },
    var.tags,
    var.extra_private_subnet_tags,
    { Name = "${var.name}-private-${local.azs[i]}", Tier = "private" },
  )]
  private_subnet_tag_assignments = merge([for i in range(var.az_count) : {
    for key, value in local.private_subnet_tags[i] : "${i}:${key}" => {
      subnet_index = i
      key          = key
      value        = value
    }
  }]...)
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
    ManagedBy   = "terraform"
    Name        = "${var.name}-public-${local.azs[count.index]}"
    Environment = lookup(var.tags, "Environment", "managed")
    Project     = lookup(var.tags, "Project", "kortix")
    Service     = lookup(var.tags, "Service", var.name)
    Platform    = lookup(var.tags, "Platform", "network")
    Tier        = "public"
  }

  # All tags are enforced by aws_ec2_tag.public_subnet below. Ignoring this
  # aggregate attribute prevents the provider from fighting those individual
  # tag resources while keeping a literal inventory map visible to scanners.
  lifecycle {
    ignore_changes = [tags]
  }
}

resource "aws_ec2_tag" "public_subnet" {
  for_each    = local.public_subnet_tag_assignments
  resource_id = aws_subnet.public[each.value.subnet_index].id
  key         = each.value.key
  value       = each.value.value
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
    ManagedBy   = "terraform"
    Name        = "${var.name}-private-${local.azs[count.index]}"
    Environment = lookup(var.tags, "Environment", "managed")
    Project     = lookup(var.tags, "Project", "kortix")
    Service     = lookup(var.tags, "Service", var.name)
    Platform    = lookup(var.tags, "Platform", "network")
    Tier        = "private"
  }

  # See the public subnet comment above. Individual resources remain the
  # enforcement boundary for every caller-supplied and discovery tag.
  lifecycle {
    ignore_changes = [tags]
  }
}

resource "aws_ec2_tag" "private_subnet" {
  for_each    = local.private_subnet_tag_assignments
  resource_id = aws_subnet.private[each.value.subnet_index].id
  key         = each.value.key
  value       = each.value.value
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
