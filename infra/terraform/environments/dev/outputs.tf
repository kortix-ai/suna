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
