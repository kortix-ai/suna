output "public_ip" {
  description = "The box's stable Elastic IP. Point your own DNS here if route53_zone_id was left empty."
  value       = module.kortix_selfhost.public_ip
}

output "instance_id" {
  value = module.kortix_selfhost.instance_id
}

output "data_volume_id" {
  value = module.kortix_selfhost.data_volume_id
}

output "dashboard_url" {
  value = module.kortix_selfhost.dashboard_url
}

output "api_url" {
  value = module.kortix_selfhost.api_url
}

output "dns_managed_by_terraform" {
  value = module.kortix_selfhost.dns_managed_by_terraform
}

output "ssm_connect_command" {
  description = "Connect to the box with no SSH key and no open SSH port."
  value       = module.kortix_selfhost.ssm_connect_command
}

output "post_apply_next_steps" {
  description = "What to do after `terraform apply` finishes — secrets are deliberately NOT Terraform inputs."
  value       = module.kortix_selfhost.post_apply_next_steps
}
