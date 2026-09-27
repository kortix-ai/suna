# Same state bucket + lock table as every other ECS-API root (see
# ../dev-us-east-2/backend.tf for why the bucket's own region need not match
# the resources' region). Only the key is new.
terraform {
  backend "s3" {
    bucket         = "kortix-terraform-state"
    key            = "staging-eu-west-2/ecs-api.tfstate"
    region         = "us-west-2"
    dynamodb_table = "kortix-terraform-locks"
    encrypt        = true
  }
}
