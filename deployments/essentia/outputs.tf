output "public_ip" {
  value = module.essentia.public_ip
}

output "instance_id" {
  value = module.essentia.instance_id
}

output "data_volume_id" {
  value = module.essentia.data_volume_id
}

output "dashboard_url" {
  value = module.essentia.dashboard_url
}

output "api_url" {
  value = module.essentia.api_url
}

output "ssm_connect_command" {
  value = module.essentia.ssm_connect_command
}

output "post_apply_next_steps" {
  value = module.essentia.post_apply_next_steps
}
