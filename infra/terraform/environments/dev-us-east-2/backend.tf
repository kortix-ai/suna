# State lives in the bucket of the region this root's resources live in
# (security-baseline/terraform-state-{region}.tf). S3 native locking
# (use_lockfile) replaces the DynamoDB lock table; objects are encrypted with
# the bucket's CMK.
terraform {
  backend "s3" {
    bucket       = "kortix-terraform-state-us-east-2-935064898258"
    key          = "dev-us-east-2/ecs-api.tfstate"
    region       = "us-east-2"
    encrypt      = true
    kms_key_id   = "alias/kortix-terraform-state-us-east-2"
    use_lockfile = true
  }
}
