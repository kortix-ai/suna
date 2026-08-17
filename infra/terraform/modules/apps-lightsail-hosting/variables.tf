variable "name" {
  description = "Environment-specific resource prefix, for example kortix-dev."
  type        = string
}

variable "environment" {
  description = "Kortix environment namespace written into provider resource names and tags."
  type        = string
}

variable "tags" {
  type    = map(string)
  default = {}
}
