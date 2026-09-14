variable "name" {
  description = <<-EOT
    Bucket name. Deterministic per environment (kortix-<env>-project-snapshots)
    so the API's non-secret task environment can name it without reading
    Terraform outputs: KORTIX_PROJECT_SNAPSHOT_S3_BUCKET must equal this value.
  EOT
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$", var.name))
    error_message = "name must be a valid S3 bucket name (lowercase letters, digits, dots, hyphens; 3–63 chars)."
  }
}

variable "expiration_days" {
  description = <<-EOT
    Days after creation before a snapshot object expires. 0 disables
    expiration. Expiry is safe: the descriptor route verifies both objects
    before answering and re-queues the ledger row when one is gone, so a
    session whose objects expired boots through Git and the next build
    republishes.
  EOT
  type        = number
  default     = 30

  validation {
    condition     = var.expiration_days >= 0 && floor(var.expiration_days) == var.expiration_days
    error_message = "expiration_days must be a non-negative whole number."
  }
}

variable "noncurrent_version_days" {
  description = "Days a noncurrent (deleted/overwritten) version is kept. Objects are never overwritten, so this only bounds the undo window of a delete."
  type        = number
  default     = 7
}

variable "kms_key_arn" {
  description = "Customer-managed KMS key for SSE-KMS. Empty = SSE-S3 (AES256)."
  type        = string
  default     = ""
}

variable "force_destroy" {
  description = "Allow `terraform destroy` to empty the bucket. Keep false outside disposable environments."
  type        = bool
  default     = false
}

variable "tags" {
  type    = map(string)
  default = {}
}
