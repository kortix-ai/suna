# Local state on purpose — this is a single demo box, not a shared Kortix
# environment. State lives at deployments/vps-demo/terraform.tfstate (gitignored,
# never commit it). See main.tf's header comment for the migrate-to-S3 note.
terraform {
  backend "local" {
    path = "terraform.tfstate"
  }
}
