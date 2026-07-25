output "api_alb_dns_name" {
  description = "Direct ALB target for SNI-based shadow API verification."
  value       = module.api.alb_dns_name
}

output "api_cluster" {
  value = module.api.cluster_name
}

output "api_service" {
  value = module.api.service_name
}

output "api_task_definition" {
  value = module.api.task_definition_arn
}

output "gateway_alb_dns_name" {
  description = "Direct ALB target for SNI-based shadow gateway verification."
  value       = module.gateway.alb_dns_name
}

output "gateway_cluster" {
  value = module.gateway.cluster_name
}

output "gateway_service" {
  value = module.gateway.service_name
}

output "gateway_task_definition" {
  value = module.gateway.task_definition_arn
}

output "vpc_id" {
  value = module.network.vpc_id
}

output "dns_managed" {
  description = "The shadow stack never creates or changes DNS records."
  value       = false
}
