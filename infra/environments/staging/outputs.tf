output "lightsail_instance_ip" {
  description = "Public IP of Lightsail instance"
  value       = module.lightsail.public_ip
}

output "static_ip" {
  description = "Static IP address"
  value       = module.lightsail.static_ip
}

output "tunnel_id" {
  description = "Cloudflare tunnel ID"
  value       = module.tunnel.tunnel_id
}
