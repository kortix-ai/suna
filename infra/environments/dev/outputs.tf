output "lightsail_instance_ip" {
  description = "Public IP of Lightsail instance"
  value       = module.lightsail.public_ip
}

output "tunnel_id" {
  description = "Cloudflare tunnel ID"
  value       = module.tunnel.tunnel_id
}

output "tunnel_cname" {
  description = "Tunnel CNAME for DNS"
  value       = module.tunnel.tunnel_cname
}
