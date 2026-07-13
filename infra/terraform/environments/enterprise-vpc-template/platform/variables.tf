variable "aws_region" {
  type    = string
  default = "us-west-2"
}
variable "state_bucket" { type = string }
variable "cluster_state_key" {
  type    = string
  default = "enterprise/cluster.tfstate"
}
variable "lock_table" { type = string }
variable "state_kms_key_arn" { type = string }
variable "cloudflare_zone_id" { type = string }
variable "cloudflare_api_token" {
  type      = string
  sensitive = true
}
variable "tags" {
  type    = map(string)
  default = {}
}
