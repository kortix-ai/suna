variable "name" {
  description = "IAM role name."
  type        = string
}

variable "oidc_provider_arn" {
  description = "Cluster IAM OIDC provider ARN (from modules/eks/cluster)."
  type        = string
}

variable "oidc_provider_url" {
  description = "Cluster OIDC issuer URL without scheme (from modules/eks/cluster)."
  type        = string
}

variable "namespace" {
  description = "Kubernetes namespace of the ServiceAccount(s)."
  type        = string
}

variable "service_accounts" {
  description = "ServiceAccount name(s) in that namespace allowed to assume this role."
  type        = list(string)
}

variable "policy_json" {
  description = "Inline IAM policy JSON to attach (\"\" = none)."
  type        = string
  default     = ""
}

variable "policy_arns" {
  description = "Managed IAM policy ARNs to attach."
  type        = list(string)
  default     = []
}

variable "max_session_duration" {
  description = "Max assumed-session duration (seconds)."
  type        = number
  default     = 3600
}

variable "tags" {
  type    = map(string)
  default = {}
}
