# Cloudflare Worker Script
resource "cloudflare_worker_script" "router" {
  account_id = var.account_id
  name       = var.worker_name
  content    = file("${path.module}/worker.js")
  module     = true

  plain_text_binding {
    name = "ACTIVE_BACKEND"
    text = var.active_backend
  }
}

# Worker Custom Domain
resource "cloudflare_worker_domain" "api" {
  account_id = var.account_id
  hostname   = var.hostname
  service    = cloudflare_worker_script.router.name
  zone_id    = var.zone_id
}
