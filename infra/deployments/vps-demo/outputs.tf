output "public_ip" {
  value = module.vps_demo.public_ip
}

output "instance_id" {
  value = module.vps_demo.instance_id
}

output "data_volume_id" {
  value = module.vps_demo.data_volume_id
}

output "dashboard_url" {
  value = module.vps_demo.dashboard_url
}

output "api_url" {
  value = module.vps_demo.api_url
}

output "ssm_connect_command" {
  value = module.vps_demo.ssm_connect_command
}

output "post_apply_next_steps" {
  value = module.vps_demo.post_apply_next_steps
}
