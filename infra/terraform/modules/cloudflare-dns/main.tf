# Generic Cloudflare DNS record manager.
# Drives a set of records from a map so callers declare DNS declaratively:
#
#   module "dns" {
#     source  = "../../modules/cloudflare-dns"
#     zone_id = var.cloudflare_zone_id
#     records = {
#       dev-api = { name = "dev-api", type = "A", value = "1.2.3.4", proxied = true }
#     }
#   }

terraform {
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = ">= 4.0, < 5.0"
    }
  }
}

resource "cloudflare_record" "this" {
  for_each = var.records

  zone_id = var.zone_id
  name    = each.value.name
  type    = each.value.type
  content = each.value.value
  proxied = each.value.proxied
  ttl     = each.value.ttl
}
