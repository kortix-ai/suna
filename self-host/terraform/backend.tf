# Local state by default — this folder is meant to be usable standalone (a
# customer's own deployment), not a Kortix-run environment. Point this at
# your own backend (S3, Terraform Cloud, ...) for real use — see
# https://developer.hashicorp.com/terraform/language/backend.
terraform {
  backend "local" {
    path = "terraform.tfstate"
  }
}
