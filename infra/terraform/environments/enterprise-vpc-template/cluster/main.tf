provider "aws" {
  region = var.aws_region
}

module "enterprise" {
  source = "../../../modules/enterprise-vpc"

  name                         = var.name
  expected_account_id          = var.expected_account_id
  vpc_cidr                     = var.vpc_cidr
  api_domain                   = var.api_domain
  frontend_domain              = var.frontend_domain
  route53_zone_id              = var.route53_zone_id
  release_repository_url       = var.release_repository_url
  tuf_root_sha256              = var.tuf_root_sha256
  updater_bootstrap_url        = var.updater_bootstrap_url
  updater_bootstrap_sha256     = var.updater_bootstrap_sha256
  release_publisher_account_id = var.release_publisher_account_id
  maintenance_window           = var.maintenance_window
  operator_principal_arns      = var.operator_principal_arns
  operator_external_id         = var.operator_external_id
  permissions_boundary_arn     = var.permissions_boundary_arn
  terraform_state_bucket       = var.terraform_state_bucket
  terraform_state_lock_table   = var.terraform_state_lock_table
  terraform_state_kms_key_arn  = var.terraform_state_kms_key_arn
  tags                         = var.tags
}

output "instance" {
  value     = module.enterprise.instance
  sensitive = true
}
output "certificate_dns_validation_records" { value = module.enterprise.certificate_dns_validation_records }
output "ecr_repositories" { value = module.enterprise.ecr_repositories }
output "backup_contract" { value = module.enterprise.backup_contract }
