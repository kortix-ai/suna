variable "aws_region" {
  type    = string
  default = "us-west-2"
}

variable "web_image" {
  description = "Immutable frontend image used to bootstrap the service. CI owns later task-definition revisions."
  type        = string
  default     = "kortix/kortix-frontend:dev-latest"
}

variable "web_certificate_arn" {
  description = "ACM wildcard certificate covering dev.kortix.com and dev-web-ecs-fargate.kortix.com."
  type        = string
  default     = "arn:aws:acm:us-west-2:935064898258:certificate/d70f1f49-d981-4add-abb6-971bad1f3755"
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

variable "manage_origin_dns" {
  description = "Create the temporary Dev ECS origin hostname."
  type        = bool
  default     = true
}

variable "manage_canonical_dns" {
  description = "Point dev.kortix.com at ECS. Keep false until origin verification passes."
  type        = bool
  default     = false
}
