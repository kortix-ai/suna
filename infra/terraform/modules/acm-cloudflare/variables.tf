variable "domain_name" {
  description = "Primary domain for the certificate (e.g. dev-api.kortix.com)."
  type        = string
}

variable "subject_alternative_names" {
  description = "Additional SANs."
  type        = list(string)
  default     = []
}

variable "zone_id" {
  description = "Cloudflare zone ID hosting the validation records."
  type        = string
}

variable "tags" {
  type    = map(string)
  default = {}
}
