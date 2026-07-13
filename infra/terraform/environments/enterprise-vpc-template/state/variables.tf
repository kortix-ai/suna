variable "aws_region" {
  type    = string
  default = "us-west-2"
}
variable "name" { type = string }
variable "expected_account_id" { type = string }
variable "state_bucket_name" { type = string }
variable "lock_table_name" { type = string }
variable "tags" {
  type    = map(string)
  default = {}
}
