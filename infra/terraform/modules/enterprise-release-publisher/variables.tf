variable "name" {
  type    = string
  default = "kortix-enterprise-releases"
}

variable "expected_account_id" {
  type = string
  validation {
    condition     = can(regex("^[0-9]{12}$", var.expected_account_id))
    error_message = "expected_account_id must be a 12-digit AWS account ID."
  }
}

variable "repository_bucket_name" {
  type = string
}

variable "repository_domain" {
  description = "Custom CloudFront hostname for the enterprise TUF repository."
  type        = string
  validation {
    condition     = can(regex("^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$", var.repository_domain))
    error_message = "repository_domain must be a lowercase DNS hostname."
  }
}

variable "repository_certificate_arn" {
  description = "Validated us-east-1 ACM certificate ARN for repository_domain."
  type        = string
  validation {
    condition     = can(regex("^arn:[^:]+:acm:us-east-1:[0-9]{12}:certificate/[0-9a-f-]+$", var.repository_certificate_arn))
    error_message = "repository_certificate_arn must be a us-east-1 ACM certificate ARN."
  }
}

variable "github_oidc_provider_arn" {
  description = "Existing GitHub Actions OIDC provider ARN in the publisher account."
  type        = string
}

variable "permissions_boundary_arn" {
  description = "Permissions boundary capping the GitHub promotion and timestamp roles."
  type        = string
  validation {
    condition     = can(regex("^arn:[^:]+:iam::[0-9]{12}:policy/.+$", var.permissions_boundary_arn))
    error_message = "permissions_boundary_arn must be an IAM policy ARN."
  }
}

variable "github_repository" {
  type    = string
  default = "kortix-ai/suna"
}

variable "github_environment" {
  description = "Protected GitHub environment whose reviewers authorize stable promotions."
  type        = string
  default     = "enterprise-stable"
}

variable "github_refresh_environment" {
  description = "Branch-restricted GitHub environment used only for automatic TUF timestamp renewal. It must not require human approval."
  type        = string
  default     = "enterprise-tuf-refresh"
}

variable "customer_event_bus_arns" {
  description = "Customer-owned release-hint buses. Hints are optional; hourly reconciliation remains authoritative."
  type        = list(string)
  default     = []
}

variable "tags" {
  type    = map(string)
  default = {}
}
