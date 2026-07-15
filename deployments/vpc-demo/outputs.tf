output "public_ip" {
  value = module.vpc_demo.public_ip
}

output "instance_id" {
  value = module.vpc_demo.instance_id
}

output "data_volume_id" {
  value = module.vpc_demo.data_volume_id
}

output "dashboard_url" {
  value = module.vpc_demo.dashboard_url
}

output "api_url" {
  value = module.vpc_demo.api_url
}

output "ssm_connect_command" {
  value = module.vpc_demo.ssm_connect_command
}

output "post_apply_next_steps" {
  value = module.vpc_demo.post_apply_next_steps
}
