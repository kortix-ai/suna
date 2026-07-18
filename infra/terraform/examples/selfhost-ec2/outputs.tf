output "public_ip" {
  value = module.kortix_selfhost.public_ip
}

output "dashboard_url" {
  value = module.kortix_selfhost.dashboard_url
}

output "api_url" {
  value = module.kortix_selfhost.api_url
}

output "ssm_connect_command" {
  value = module.kortix_selfhost.ssm_connect_command
}

output "post_apply_next_steps" {
  value = module.kortix_selfhost.post_apply_next_steps
}
