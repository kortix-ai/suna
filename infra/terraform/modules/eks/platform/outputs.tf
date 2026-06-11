output "alb_controller_role_arn" {
  value = module.alb_controller_irsa.role_arn
}

output "cluster_autoscaler_role_arn" {
  value = module.cluster_autoscaler_irsa.role_arn
}

output "controllers" {
  description = "Installed platform controllers + pinned chart versions."
  value = {
    aws_load_balancer_controller = var.alb_controller_chart_version
    external_secrets             = var.external_secrets_chart_version
    external_dns                 = var.external_dns_chart_version
    metrics_server               = var.metrics_server_chart_version
    cluster_autoscaler           = var.cluster_autoscaler_chart_version
  }
}
