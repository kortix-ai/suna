variable "name" {
  type        = string
  description = "Kortix instance slug."
}
variable "expected_account_id" {
  type        = string
  description = "Customer account that owns the state plane."

  validation {
    condition     = can(regex("^[0-9]{12}$", var.expected_account_id))
    error_message = "expected_account_id must be a 12-digit AWS account ID."
  }
}

variable "state_bucket_name" {
  type        = string
  description = "Globally unique customer-owned Terraform state bucket."
}

variable "lock_table_name" {
  type        = string
  description = "DynamoDB state lock table."
}

variable "tags" {
  type    = map(string)
  default = {}
}
