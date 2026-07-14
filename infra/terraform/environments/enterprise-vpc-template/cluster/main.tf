provider "aws" {
  region = var.aws_region
}

module "enterprise" {
  source = "../../../modules/enterprise-vpc"

  name                     = var.name
  expected_account_id      = var.expected_account_id
  vpc_cidr                 = var.vpc_cidr
  api_domain               = var.api_domain
  frontend_domain          = var.frontend_domain
  route53_zone_id          = var.route53_zone_id
  release_repository_url   = var.release_repository_url
  tuf_root_sha256          = var.tuf_root_sha256
  maintenance_window       = var.maintenance_window
  operator_principal_arns  = var.operator_principal_arns
  operator_external_id     = var.operator_external_id
  permissions_boundary_arn = var.permissions_boundary_arn

  # Appliance / ingress / Bedrock knobs (all default-sane; overridable).
  ingress_cidrs           = var.ingress_cidrs
  bedrock_model_allowlist = var.bedrock_model_allowlist
  appliance_instance_type = var.appliance_instance_type

  tags = var.tags
}

output "instance" {
  value     = module.enterprise.instance
  sensitive = true
}
output "ecr_repositories" { value = module.enterprise.ecr_repositories }
output "backup_contract" { value = module.enterprise.backup_contract }
output "public_ip" { value = module.enterprise.public_ip }
output "app_dns_records" { value = module.enterprise.app_dns_records }
