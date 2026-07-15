# Local state on purpose: this is a customer-facing example, not a Kortix-run
# environment (unlike environments/*, which use the shared kortix-terraform-state
# S3 backend). Point this at your own backend (S3, Terraform Cloud, ...) for
# real use — see https://developer.hashicorp.com/terraform/language/backend.
terraform {
  backend "local" {
    path = "terraform.tfstate"
  }
}
