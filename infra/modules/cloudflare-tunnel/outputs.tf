output "tunnel_id" {
  description = "ID of the Cloudflare tunnel"
  value       = cloudflare_tunnel.this.id
}

output "tunnel_name" {
  description = "Name of the Cloudflare tunnel"
  value       = cloudflare_tunnel.this.name
}

output "tunnel_cname" {
  description = "CNAME for the tunnel (for DNS records)"
  value       = "${cloudflare_tunnel.this.id}.cfargotunnel.com"
}

output "tunnel_secret" {
  description = "Tunnel secret (sensitive)"
  value       = cloudflare_tunnel.this.secret
  sensitive   = true
}
