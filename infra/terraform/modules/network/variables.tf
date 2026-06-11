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

# ── EKS subnet discovery tags (optional; empty = no-op for the ECS envs) ───────
# EKS needs subnets tagged so the AWS Load Balancer Controller can auto-discover
# where to place ALBs (`kubernetes.io/role/elb` on public, `.../internal-elb` on
# private) and so the cluster claims them (`kubernetes.io/cluster/<name>`=shared).
# Passed through as extra tags so the SAME generic module serves both the ECS
# stacks (no extra tags) and the EKS stack — no fork. See modules/eks/cluster and
# environments/prod-eks.
variable "extra_vpc_tags" {
  description = "Additional tags merged onto the VPC (e.g. kubernetes.io/cluster/<name>=shared for EKS)."
  type        = map(string)
  default     = {}
}

variable "extra_public_subnet_tags" {
  description = "Additional tags merged onto every public subnet (e.g. kubernetes.io/role/elb=1)."
  type        = map(string)
  default     = {}
}

variable "extra_private_subnet_tags" {
  description = "Additional tags merged onto every private subnet (e.g. kubernetes.io/role/internal-elb=1)."
  type        = map(string)
  default     = {}
}
