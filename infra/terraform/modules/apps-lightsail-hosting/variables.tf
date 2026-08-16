variable "name" {
  description = "Environment-specific resource prefix, for example kortix-dev."
  type        = string
}

variable "environment" {
  description = "Kortix environment namespace written into provider resource names and tags."
  type        = string
}

variable "aws_region" {
  description = "AWS region for CodeBuild, ECR, S3, and Lightsail Container Services."
  type        = string
}

variable "tags" {
  type    = map(string)
  default = {}
}
