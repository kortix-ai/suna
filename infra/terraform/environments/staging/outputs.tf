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

output "apps_lightsail_hosting" {
  value = {
    build_bucket       = module.apps_lightsail_hosting.build_bucket
    ecr_repository_uri = module.apps_lightsail_hosting.ecr_repository_uri
    codebuild_project  = module.apps_lightsail_hosting.codebuild_project
  }
}
