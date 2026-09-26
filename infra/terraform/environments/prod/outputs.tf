output "alb_dns_name" {
  description = "ALB DNS name behind api.kortix.com."
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
  # When manage_dns is off the api.kortix.com record is NOT terraform-managed
  # (cutover is done out-of-band); expose the ALB DNS as the cutover target.
  value = var.manage_dns ? one(module.dns[*].record_hostnames) : { alb_dns_name = module.api.alb_dns_name }
}

output "extra_api_hostnames" {
  description = "Unlocked public API hostnames pointing at the new ALB."
  value       = var.extra_api_hostnames
}

output "project_snapshot_bucket" {
  description = "Value for KORTIX_PROJECT_SNAPSHOT_S3_BUCKET in this environment's non-secret task env overrides."
  value       = module.project_snapshots.bucket_name
}
