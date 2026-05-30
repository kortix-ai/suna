# Remote state in S3 with DynamoDB locking. Run scripts/bootstrap-state.sh once
# to create the bucket + lock table, then `terraform init -migrate-state`.
#
# Until bootstrapped, this block can be left commented to use local state for
# the initial import/validation, then uncommented + migrated.

terraform {
  backend "s3" {
    bucket         = "kortix-terraform-state"
    key            = "dev/api-host.tfstate"
    region         = "us-west-2"
    dynamodb_table = "kortix-terraform-locks"
    encrypt        = true
  }
}
