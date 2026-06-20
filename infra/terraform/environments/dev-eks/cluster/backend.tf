terraform {
  backend "s3" {
    bucket         = "kortix-terraform-state"
    key            = "dev-eks/cluster.tfstate"
    region         = "us-west-2"
    dynamodb_table = "kortix-terraform-locks"
    encrypt        = true
  }
}
