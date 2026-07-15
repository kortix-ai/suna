variable "aws_region" {
  description = "AWS region to provision the box in."
  type        = string
  default     = "us-west-2"
}

variable "domain" {
  description = "Public domain to run this instance on (DNS must point here — see the module README for the no-Route53 path)."
  type        = string
}

variable "route53_zone_id" {
  description = "Optional Route53 hosted zone ID for var.domain. Leave empty to manage DNS yourself (the module still outputs the Elastic IP to point at)."
  type        = string
  default     = ""
}
