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

  # ECS / ALB / Bedrock / scheduler knobs (all default-sane; overridable).
  alb_ingress_cidrs             = var.alb_ingress_cidrs
  bedrock_model_allowlist       = var.bedrock_model_allowlist
  enable_scheduled_deploy       = var.enable_scheduled_deploy
  scheduler_schedule_expression = var.scheduler_schedule_expression
  api_image                     = var.api_image
  gateway_image                 = var.gateway_image
  frontend_image                = var.frontend_image
  deployer_image                = var.deployer_image

  tags = var.tags
}

output "instance" {
  value     = module.enterprise.instance
  sensitive = true
}
output "certificate_dns_validation_records" { value = module.enterprise.certificate_dns_validation_records }
output "ecr_repositories" { value = module.enterprise.ecr_repositories }
output "backup_contract" { value = module.enterprise.backup_contract }
output "alb_dns_name" { value = module.enterprise.alb_dns_name }
output "alb_zone_id" { value = module.enterprise.alb_zone_id }
