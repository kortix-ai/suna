output "alb_dns_name" {
  value = module.api.alb_dns_name
}

output "gateway_alb_dns_name" {
  value = module.gateway.alb_dns_name
}

output "ecs_cluster" {
  value = module.api.cluster_name
}

output "ecs_service" {
  value = module.api.service_name
}

output "log_group" {
  value = module.api.log_group
}

output "dns_records" {
  value = try(one(module.dns[*].record_hostnames), null)
}

output "project_snapshot_bucket" {
  description = "Value for KORTIX_PROJECT_SNAPSHOT_S3_BUCKET once this root is cut over (deploy-staging.yml's KORTIX_ECS_ENV_OVERRIDES)."
  value       = module.project_snapshots.bucket_name
}

output "database_region" {
  description = "Declared region of this environment's DATABASE_URL secret (see variables.tf). Exists so infra/terraform/scripts/test_region_colocation.py's source variable is a real, tflint-visible usage, and so `terraform output` surfaces it for a human too."
  value       = var.database_region
}

output "audit_archive_bucket" {
  description = "Value for AUDIT_ARCHIVE_BUCKET in this environment's non-secret task env overrides."
  value       = module.audit_archive.bucket_name
}
