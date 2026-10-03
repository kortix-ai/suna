output "alb_dns_name" {
  description = "ALB DNS name behind dev-api.kortix.com."
  value       = module.api.alb_dns_name
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
  description = "Value for KORTIX_PROJECT_SNAPSHOT_S3_BUCKET in this environment's non-secret task env overrides."
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

output "capture_store_bucket" {
  description = "KORTIX_CAPTURE_S3_BUCKET for the API task environment."
  value       = module.capture_store.bucket_name
}

output "capture_store_queue_url" {
  description = "KORTIX_CAPTURE_SQS_QUEUE_URL for the API task environment."
  value       = module.capture_store.queue_url
}

output "capture_store_device_role_arn" {
  description = "KORTIX_CAPTURE_STS_ROLE_ARN for the API task environment."
  value       = module.capture_store.device_role_arn
}
