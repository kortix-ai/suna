output "public_ip" {
  description = "dev-api.kortix.com origin IP."
  value       = module.api_host.public_ip
}

output "instance_name" {
  value = module.api_host.instance_name
}
