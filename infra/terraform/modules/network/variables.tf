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

# ── Default network ACL ───────────────────────────────────────────────────────
# A VPC's AWS-created default NACL permits every protocol from 0.0.0.0/0, which
# leaves SSH (22) and RDP (3389) publicly reachable at the subnet boundary. This
# module adopts that default NACL and replaces its rules with a baseline that
# carves both admin ports out of the public ranges, so every VPC is compliant by
# construction instead of by hand-editing each one after the fact.
#
# Set false ONLY when another Terraform root already owns this VPC's default
# NACL (owning the same resource from two states makes them fight on apply).
variable "manage_default_network_acl" {
  description = "Adopt the VPC's default NACL and enforce the restricted baseline. Set false if another root owns it."
  type        = bool
  default     = true
}

variable "public_ingress_tcp_ports" {
  description = "Public TCP ports opened individually below the ephemeral range (e.g. 80, 443)."
  type        = list(number)
  default     = [80, 443]

  validation {
    condition     = !contains(var.public_ingress_tcp_ports, 22) && !contains(var.public_ingress_tcp_ports, 3389)
    error_message = "public_ingress_tcp_ports must not contain 22 (SSH) or 3389 (RDP); these must never be reachable from 0.0.0.0/0."
  }
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
