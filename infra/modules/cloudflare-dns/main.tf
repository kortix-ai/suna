# DNS Records
resource "cloudflare_record" "this" {
  for_each = var.records

  zone_id        = var.zone_id
  name           = each.value.name
  type           = each.value.type
  content        = each.value.value
  proxied        = each.value.proxied
  ttl            = each.value.ttl
  comment        = each.value.comment
  allow_overwrite = true  # Allow overwriting existing records
}
