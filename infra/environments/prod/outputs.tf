output "lightsail_instance_ip" {
  description = "Public IP of Lightsail instance"
  value       = module.lightsail.public_ip
}

output "static_ip" {
  description = "Static IP address"
  value       = module.lightsail.static_ip
}

output "vpc_id" {
  description = "VPC ID"
  value       = module.vpc.vpc_id
}

output "alb_dns_name" {
  description = "ALB DNS name"
  value       = module.alb.alb_dns_name
}

output "ecs_cluster_name" {
  description = "ECS cluster name"
  value       = module.ecs.cluster_name
}

output "ecs_service_name" {
  description = "ECS service name"
  value       = module.ecs.service_name
}

output "tunnel_id" {
  description = "Cloudflare tunnel ID"
  value       = module.tunnel_lightsail.tunnel_id
}

output "worker_name" {
  description = "Cloudflare Worker name"
  value       = module.worker.worker_name
}
