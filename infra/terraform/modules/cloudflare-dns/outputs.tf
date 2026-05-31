output "record_hostnames" {
  description = "Map of record key -> fully-qualified hostname."
  value       = { for k, r in cloudflare_record.this : k => r.hostname }
}

output "record_ids" {
  description = "Map of record key -> Cloudflare record ID."
  value       = { for k, r in cloudflare_record.this : k => r.id }
}
