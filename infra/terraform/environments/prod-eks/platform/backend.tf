terraform {
  backend "s3" {
    bucket         = "kortix-terraform-state"
    key            = "prod-eks/platform.tfstate"
    region         = "eu-west-2"
    dynamodb_table = "kortix-terraform-locks"
    encrypt        = true
  }
}
