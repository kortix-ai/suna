output "record_ids" {
  description = "Map of DNS record IDs"
  value       = { for k, v in cloudflare_record.this : k => v.id }
}

output "records" {
  description = "Map of DNS records"
  value       = { for k, v in cloudflare_record.this : k => {
    name    = v.name
    type    = v.type
    value   = v.value
    proxied = v.proxied
  } }
}
