module "network" {
  source             = "../network"
  name               = var.name
  cidr               = var.vpc_cidr
  az_count           = 3
  single_nat_gateway = false
  tags               = local.tags

  extra_vpc_tags = {
    "kubernetes.io/cluster/${var.name}" = "shared"
  }
  extra_public_subnet_tags = {
    "kubernetes.io/role/elb"            = "1"
    "kubernetes.io/cluster/${var.name}" = "shared"
  }
  extra_private_subnet_tags = {
    "kubernetes.io/role/internal-elb"   = "1"
    "kubernetes.io/cluster/${var.name}" = "shared"
  }
}
resource "aws_security_group" "endpoints" {
  name_prefix = "${var.name}-endpoints-"
  description = "TLS access to private AWS service endpoints"
  vpc_id      = module.network.vpc_id

  ingress {
    description = "HTTPS from the installation VPC"
    protocol    = "tcp"
    from_port   = 443
    to_port     = 443
    cidr_blocks = [var.vpc_cidr]
  }

  egress {
    description = "Endpoint responses inside the VPC"
    protocol    = "-1"
    from_port   = 0
    to_port     = 0
    cidr_blocks = [var.vpc_cidr]
  }

  tags = merge(local.tags, { Name = "${var.name}-endpoints" })
}

locals {
  interface_endpoints = toset([
    "bedrock-runtime",
    "ec2messages",
    "ecr.api",
    "ecr.dkr",
    "kms",
    "logs",
    "secretsmanager",
    "ssm",
    "ssmmessages",
    "sts",
  ])
}

resource "aws_vpc_endpoint" "interface" {
  for_each            = local.interface_endpoints
  vpc_id              = module.network.vpc_id
  service_name        = "com.amazonaws.${local.region}.${each.value}"
  vpc_endpoint_type   = "Interface"
  private_dns_enabled = true
  subnet_ids          = module.network.private_subnet_ids
  security_group_ids  = [aws_security_group.endpoints.id]
  tags                = merge(local.tags, { Name = "${var.name}-${replace(each.value, ".", "-")}" })
}

resource "aws_vpc_endpoint" "s3" {
  vpc_id            = module.network.vpc_id
  service_name      = "com.amazonaws.${local.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = module.network.private_route_table_ids
  tags              = merge(local.tags, { Name = "${var.name}-s3" })
}
