output "public_ip" {
  description = "dev-api.kortix.com origin IP (Lightsail static IP)."
  value       = module.api_host.public_ip
}

output "instance_name" {
  value = module.api_host.instance_name
}

output "dns_records" {
  description = "Managed Cloudflare record hostnames (empty until the DNS module is applied)."
  value       = module.dns.record_hostnames
}
