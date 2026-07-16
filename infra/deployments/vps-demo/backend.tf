# Local state on purpose — this is a single demo box, not a shared Kortix
# environment. State lives at infra/deployments/vps-demo/terraform.tfstate (gitignored,
# never commit it). See main.tf's header comment for the migrate-to-S3 note.
#
# Known tradeoff (documented, not "fixed" here): local state is unlocked —
# two people (or an agent + a person) running `terraform apply` from
# different checkouts at the same time can race and corrupt state, and the
# only copy lives on whichever machine last applied. That's an accepted risk
# for a single demo box with one operator. If this ever becomes a
# team-shared environment, move to the standard S3 + DynamoDB-lock backend
# used by infra/terraform/environments/* — sketch:
#
# terraform {
#   backend "s3" {
#     bucket         = "kortix-terraform-state"
#     key            = "deployments/vps-demo/terraform.tfstate"
#     region         = "us-east-1"
#     dynamodb_table = "kortix-terraform-locks" # state locking
#     encrypt        = true
#   }
# }
#
# Migrating: after adding the block above (and removing the "local" block),
# run `terraform init -migrate-state` once from a checkout that has the
# current terraform.tfstate, then delete the local state file.
terraform {
  backend "local" {
    path = "terraform.tfstate"
  }
}
