output "cluster_name" {
  value = module.eks.cluster_name
}

output "cluster_endpoint" {
  value = module.eks.cluster_endpoint
}

output "cluster_ca_data" {
  value     = module.eks.cluster_ca_data
  sensitive = true
}

output "oidc_provider_arn" {
  value = module.eks.oidc_provider_arn
}

output "oidc_provider_url" {
  value = module.eks.oidc_provider_url
}

output "vpc_id" {
  value = module.network.vpc_id
}

output "aws_region" {
  value = var.aws_region
}

output "api_domain" {
  value = var.api_domain
}

output "acm_certificate_arn" {
  description = "Cert ARN for the ALB HTTPS listener (Ingress annotation)."
  value       = module.acm.certificate_arn
}

output "acm_argocd_certificate_arn" {
  description = "Cert ARN for the Argo CD UI ALB (ops.kortix.com)."
  value       = module.acm_argocd.certificate_arn
}

output "argocd_domain" {
  value = var.argocd_domain
}

output "app_irsa_role_arn" {
  description = "IRSA role ARN for the app ServiceAccount (Secrets Manager read)."
  value       = module.app_irsa.role_arn
}

output "app_namespace" {
  value = var.app_namespace
}

output "app_service_account" {
  value = var.app_service_account
}

output "app_secret_name" {
  value = var.app_secret_name
}

output "ci_deploy_role_arn" {
  description = "Role GitHub Actions assumes to deploy (put in deploy-prod-eks.yml)."
  value       = aws_iam_role.ci_deploy.arn
}

output "configure_kubectl" {
  description = "Command to get a local kubeconfig for this cluster."
  value       = "aws eks update-kubeconfig --region ${var.aws_region} --name ${module.eks.cluster_name}"
}
