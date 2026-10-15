variable "name" {
  description = <<-EOT
    Bucket name, also the prefix of the queue and device role names.
    Deterministic per environment (kortix-<env>-capture-store) so the API's
    non-secret task environment can name it: KORTIX_CAPTURE_S3_BUCKET must
    equal this value.
  EOT
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,50}[a-z0-9]$", var.name))
    error_message = "name must be a valid S3 bucket name without dots, at most 52 characters (the queue and role names add suffixes)."
  }
}

variable "api_task_role_arn" {
  description = "The API task role (modules/ecs-api output task_role_arn): the only principal that may assume the device role."
  type        = string
}

variable "expiration_days" {
  description = "Backstop expiry of every object, above the API's longest retention (policy.retention.remote_days max 3650)."
  type        = number
  default     = 3660
}

variable "noncurrent_version_days" {
  description = "Days an overwritten or deleted version is kept."
  type        = number
  default     = 7
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
