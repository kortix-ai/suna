variable "account_id" {
  description = "Cloudflare account ID"
  type        = string
}

variable "zone_id" {
  description = "Cloudflare zone ID"
  type        = string
}

variable "worker_name" {
  description = "Name of the Cloudflare Worker"
  type        = string
}

variable "hostname" {
  description = "Hostname for the worker custom domain"
  type        = string
}

variable "active_backend" {
  description = "Active backend (lightsail or ecs)"
  type        = string
  default     = "lightsail"
}

variable "tags" {
  description = "Tags to apply to resources"
  type        = map(string)
  default     = {}
}
