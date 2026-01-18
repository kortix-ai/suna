# Note: random_password requires random provider
# Generate random secret for tunnel (if not provided)
resource "random_password" "tunnel_secret" {
  count   = var.tunnel_secret == null ? 1 : 0
  length  = 32
  special = true
}

# Cloudflare Tunnel
resource "cloudflare_tunnel" "this" {
  account_id = var.account_id
  name       = var.tunnel_name
  secret     = var.tunnel_secret != null ? var.tunnel_secret : random_password.tunnel_secret[0].result

  lifecycle {
    ignore_changes = [
      secret, # Secret is managed externally, don't regenerate
    ]
  }
}

# Tunnel Configuration
resource "cloudflare_tunnel_config" "this" {
  account_id = var.account_id
  tunnel_id  = cloudflare_tunnel.this.id

  config {
    dynamic "ingress_rule" {
      for_each = var.ingress_rules
      content {
        hostname = ingress_rule.value.hostname
        service  = ingress_rule.value.service

        dynamic "origin_request" {
          for_each = ingress_rule.value.origin_request != null ? [ingress_rule.value.origin_request] : []
          content {
            connect_timeout = origin_request.value.connect_timeout
            tls_timeout     = origin_request.value.tls_timeout
            tcp_keep_alive  = origin_request.value.tcp_keep_alive
          }
        }
      }
    }

    ingress_rule {
      service = "http_status:404"
    }
  }
}
