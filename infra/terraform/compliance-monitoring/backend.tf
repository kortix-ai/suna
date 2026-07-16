terraform {
  backend "s3" {
    bucket         = "kortix-terraform-state"
    key            = "security/compliance-monitoring.tfstate"
    region         = "us-west-2"
    dynamodb_table = "kortix-terraform-locks"
    encrypt        = true
  }
}
