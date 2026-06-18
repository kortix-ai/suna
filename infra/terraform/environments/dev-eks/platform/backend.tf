terraform {
  backend "s3" {
    bucket         = "kortix-terraform-state"
    key            = "dev-eks/platform.tfstate"
    region         = "eu-west-2"
    dynamodb_table = "kortix-terraform-locks"
    encrypt        = true
  }
}
