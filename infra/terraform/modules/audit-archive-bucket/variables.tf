variable "name" {
  description = <<-EOT
    Bucket name. Deterministic per environment (<env>-audit-archive) so the
    API's non-secret task environment can name it without reading Terraform
    outputs: AUDIT_ARCHIVE_BUCKET must equal this value.
  EOT
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$", var.name))
    error_message = "name must be a valid S3 bucket name (lowercase letters, digits, dots, hyphens; 3–63 chars)."
  }
}

variable "retention_days" {
  description = <<-EOT
    Default Object Lock retention in days, and the lifetime of current objects
    (they expire at retention_days + 1). The privacy policy keeps application
    logs up to 365 days. The API job sets a per-object retain-until date of
    occurred_at + 365 days; the bucket default is the floor for any object
    written without one.
  EOT
  type        = number
  default     = 365

  validation {
    condition     = var.retention_days >= 1 && floor(var.retention_days) == var.retention_days
    error_message = "retention_days must be a positive whole number."
  }
}

variable "object_lock_mode" {
  description = <<-EOT
    Default Object Lock mode. COMPLIANCE: no principal, root included, can
    shorten retention or delete a locked object version before it ends, and the
    bucket cannot be emptied or destroyed until then. GOVERNANCE: principals
    with s3:BypassGovernanceRetention can. Prod roots keep COMPLIANCE; use
    GOVERNANCE only in disposable environments.
  EOT
  type        = string
  default     = "COMPLIANCE"

  validation {
    condition     = contains(["COMPLIANCE", "GOVERNANCE"], var.object_lock_mode)
    error_message = "object_lock_mode must be COMPLIANCE or GOVERNANCE."
  }
}

variable "noncurrent_version_days" {
  description = "Days a noncurrent version is kept before it expires. Object Lock still blocks deletion until each version's retention ends."
  type        = number
  default     = 7
}

variable "tags" {
  type    = map(string)
  default = {}
}
