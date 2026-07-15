# Retained for the no-op platform stage (see main.tf). The old remote-state
# indirection (state_bucket / cluster_state_key / lock_table / state_kms_key_arn)
# is gone: DNS now lives in the cluster stage.
variable "aws_region" {
  type    = string
  default = "us-west-2"
}
