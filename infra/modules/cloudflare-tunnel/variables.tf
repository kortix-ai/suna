variable "account_id" {
  description = "Cloudflare account ID"
  type        = string
}

variable "tunnel_name" {
  description = "Name of the Cloudflare tunnel"
  type        = string
}

variable "tunnel_secret" {
  description = "Tunnel secret (if null, will be generated)"
  type        = string
  default     = null
  sensitive   = true
}

variable "ingress_rules" {
  description = "List of ingress rules for the tunnel"
  type = list(object({
    hostname      = string
    service       = string
    origin_request = optional(object({
      connect_timeout = optional(number)
      tls_timeout     = optional(number)
      tcp_keep_alive  = optional(number)
    }))
  }))
}

variable "tags" {
  description = "Tags to apply to resources"
  type        = map(string)
  default     = {}
}
