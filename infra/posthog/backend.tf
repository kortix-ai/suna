# State lives in the eu-west-2 state bucket, next to the PostHog EU Cloud
# project it describes. S3 native locking (use_lockfile); objects are
# encrypted with the bucket's CMK. Run with AWS_PROFILE=kortix.
terraform {
  backend "s3" {
    bucket       = "kortix-terraform-state-eu-west-2-935064898258"
    key          = "posthog/dashboards.tfstate"
    region       = "eu-west-2"
    encrypt      = true
    kms_key_id   = "alias/kortix-terraform-state-eu-west-2"
    use_lockfile = true
  }
}
