variable "name" {
  description = "Cluster name + prefix for cluster/node IAM roles (e.g. kortix-prod-eks)."
  type        = string
}

variable "cluster_version" {
  description = "EKS Kubernetes minor version."
  type        = string
  default     = "1.32"
}

# ── Networking ────────────────────────────────────────────────────────────────
variable "control_plane_subnet_ids" {
  description = "Subnets for the control-plane cross-account ENIs (public + private is fine)."
  type        = list(string)
}

variable "node_subnet_ids" {
  description = "Private subnets the worker nodes run in (egress via NAT)."
  type        = list(string)
}

variable "endpoint_public_access" {
  description = "Expose the Kubernetes API endpoint publicly (still IAM-authenticated). Lock with endpoint_public_access_cidrs."
  type        = bool
  default     = true
}

variable "endpoint_public_access_cidrs" {
  description = "CIDRs allowed to reach the public Kubernetes API endpoint. Tighten to office/CI egress in prod."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

# ── Node group sizing / resilience ────────────────────────────────────────────
variable "node_instance_types" {
  description = "Instance types for the managed node group."
  type        = list(string)
  default     = ["m6i.large"]
}

variable "node_capacity_type" {
  description = "ON_DEMAND (prod stability) or SPOT (cheaper, interruptible)."
  type        = string
  default     = "ON_DEMAND"
}

variable "node_disk_size" {
  description = "Node root EBS volume size (GiB)."
  type        = number
  default     = 50
}

variable "node_desired_size" {
  description = "Initial node count (cluster-autoscaler owns it afterward). Use >= az_count for one-per-AZ."
  type        = number
  default     = 3
}

variable "node_min_size" {
  description = "Autoscaling floor for nodes. Keep >= number of AZs for HA spread."
  type        = number
  default     = 3
}

variable "node_max_size" {
  description = "Autoscaling ceiling for nodes."
  type        = number
  default     = 9
}

variable "node_max_unavailable_percentage" {
  description = "Max % of the node group taken down at once during an AMI/version roll."
  type        = number
  default     = 33
}

variable "enable_node_auto_repair" {
  description = "Let EKS auto-detect and replace unhealthy nodes."
  type        = bool
  default     = true
}

variable "node_labels" {
  description = "Extra Kubernetes node labels."
  type        = map(string)
  default     = {}
}

# ── Observability ─────────────────────────────────────────────────────────────
variable "cluster_log_types" {
  description = "Control-plane log types shipped to CloudWatch."
  type        = list(string)
  default     = ["api", "audit", "authenticator", "controllerManager", "scheduler"]
}

variable "secrets_encryption_kms_key_arn" {
  description = "Optional customer KMS key for Kubernetes secret envelope encryption."
  type        = string
  default     = null
}

variable "bootstrap_cluster_creator_admin_permissions" {
  description = "Grant the creating principal permanent bootstrap cluster-admin. Enterprise installs disable this and use explicit access entries."
  type        = bool
  default     = true
}

variable "permissions_boundary_arn" {
  description = "Optional permissions boundary for the EBS CSI workload role. EKS control-plane and node roles are excluded because their AWS-managed policies require network-interface operations forbidden by the enterprise boundary."
  type        = string
  default     = null
}

variable "tags" {
  type    = map(string)
  default = {}
}
