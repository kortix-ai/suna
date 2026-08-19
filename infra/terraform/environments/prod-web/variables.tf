variable "aws_region" {
  type    = string
  default = "eu-west-2"
}

variable "web_image" {
  description = "Immutable frontend image used to bootstrap the service. CI owns later task-definition revisions."
  type        = string
  default     = "kortix/kortix-frontend:latest"
}

variable "cloudflare_zone_id" {
  type    = string
  default = "af378d3df4e4dd5052a1fcbf263b685d"
}

variable "cloudflare_api_token" {
  type      = string
  default   = ""
  sensitive = true
}

variable "manage_dns" {
  description = "Create only prod-fe-ecs.kortix.com. This stack never manages kortix.com."
  type        = bool
  default     = true
}
