output "alb_dns_name" {
  value = aws_lb.preview.dns_name
}

output "cluster_name" {
  value = aws_ecs_cluster.preview.name
}

output "deploy_role_arn" {
  value = aws_iam_role.github_preview_deploy.arn
}

output "listener_arn" {
  value = aws_lb_listener.https.arn
}

output "private_subnet_ids" {
  value = data.aws_subnets.dev_private.ids
}

output "service_security_group_id" {
  value = aws_security_group.service.id
}
