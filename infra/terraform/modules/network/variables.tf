variable "name" {
  description = "Name prefix for VPC resources (e.g. kortix-dev)."
  type        = string
}

variable "cidr" {
  description = "VPC CIDR block (a /16 gives room for the /20 subnet carving)."
  type        = string
  default     = "10.0.0.0/16"
}

variable "az_count" {
  description = "Number of AZs to spread public/private subnets across. 2 is the minimum for ALB."
  type        = number
  default     = 2
}

variable "single_nat_gateway" {
  description = "true = one shared NAT gateway (cheaper, dev). false = one per AZ (HA, prod)."
  type        = bool
  default     = true
}

variable "tags" {
  description = "Tags applied to all network resources."
  type        = map(string)
  default     = {}
}
