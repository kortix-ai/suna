variable "zone_id" {
  description = "Cloudflare zone ID"
  type        = string
}

variable "records" {
  description = "Map of DNS records to create"
  type = map(object({
    name    = string
    type    = string
    value   = string
    proxied = optional(bool, false)
    ttl     = optional(number, 1) # 1 = auto
    comment = optional(string, "")
  }))
}

variable "tags" {
  description = "Tags to apply to resources"
  type        = map(string)
  default     = {}
}
