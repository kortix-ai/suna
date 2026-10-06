output "alb_dns_name" {
  value = module.web.alb_dns_name
}

output "ecs_cluster" {
  value = module.web.cluster_name
}

output "ecs_service" {
  value = module.web.service_name
}

output "dns_records" {
  value = try(one(module.dns[*].record_hostnames), null)
}
