module "eks" {
  source          = "../eks/cluster"
  name            = var.name
  cluster_version = var.cluster_version

  control_plane_subnet_ids = module.network.private_subnet_ids
  node_subnet_ids          = module.network.private_subnet_ids

  # Operators, GitHub, and Kortix never need a public Kubernetes endpoint.
  # Platform bootstrap and reconciliation execute from customer-owned CodeBuild
  # attached to these private subnets.
  endpoint_public_access                      = false
  endpoint_public_access_cidrs                = []
  secrets_encryption_kms_key_arn              = aws_kms_key.data.arn
  bootstrap_cluster_creator_admin_permissions = false
  permissions_boundary_arn                    = var.permissions_boundary_arn

  node_instance_types = var.node_instance_types
  node_desired_size   = var.node_desired_size
  node_min_size       = var.node_min_size
  node_max_size       = var.node_max_size

  tags = local.tags

  depends_on = [terraform_data.account_guard]
}

resource "aws_vpc_security_group_ingress_rule" "updater_eks_api" {
  security_group_id            = module.eks.cluster_security_group_id
  referenced_security_group_id = aws_security_group.updater.id
  description                  = "Private Kubernetes API access from the customer-owned updater"
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443

  tags = local.tags
}

data "aws_iam_policy_document" "app_secrets" {
  statement {
    actions   = ["secretsmanager:DescribeSecret", "secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.runtime.arn]
  }
  statement {
    actions   = ["kms:Decrypt", "kms:DescribeKey"]
    resources = [aws_kms_key.secrets.arn]
  }
}

module "app_irsa" {
  source                   = "../eks/irsa"
  name                     = "${var.name}-app"
  oidc_provider_arn        = module.eks.oidc_provider_arn
  oidc_provider_url        = module.eks.oidc_provider_url
  namespace                = var.app_namespace
  service_accounts         = [var.app_service_account]
  create_inline_policy     = true
  policy_json              = data.aws_iam_policy_document.app_secrets.json
  permissions_boundary_arn = var.permissions_boundary_arn
  tags                     = local.tags
}
