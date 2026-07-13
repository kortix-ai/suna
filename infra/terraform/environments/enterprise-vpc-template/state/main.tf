provider "aws" {
  region = var.aws_region
}

module "state" {
  source              = "../../../modules/enterprise-state"
  name                = var.name
  expected_account_id = var.expected_account_id
  state_bucket_name   = var.state_bucket_name
  lock_table_name     = var.lock_table_name
  tags                = var.tags
}

output "backend_config" { value = module.state.backend_config }
output "permissions_boundary_arn" { value = module.state.permissions_boundary_arn }
