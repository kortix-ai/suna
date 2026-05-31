variable "zone_id" {
  description = "Cloudflare zone ID the records live in (e.g. the kortix.com zone)."
  type        = string
}

variable "records" {
  description = "Map of DNS records to manage, keyed by a stable name. proxied=true puts the record behind Cloudflare's proxy (must use ttl=1)."
  type = map(object({
    name    = string
    type    = string
    value   = string
    proxied = bool
    ttl     = number
  }))
  default = {}
}
