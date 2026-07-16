# Local state on purpose — this is a single customer box in Essentia's own
# AWS account, not a shared Kortix environment. State lives at
# deployments/essentia/terraform.tfstate (gitignored, never commit it). See
# main.tf's header comment.
terraform {
  backend "local" {
    path = "terraform.tfstate"
  }
}
