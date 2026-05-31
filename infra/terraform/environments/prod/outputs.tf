output "public_ip" {
  description = "prod (api.kortix.com) origin IP."
  value       = module.api_host.public_ip
}

output "instance_name" {
  value = module.api_host.instance_name
}
