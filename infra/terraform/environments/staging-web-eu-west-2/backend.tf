terraform {
  backend "s3" {
    bucket         = "kortix-terraform-state"
    key            = "staging-eu-west-2/ecs-web.tfstate"
    region         = "us-west-2"
    dynamodb_table = "kortix-terraform-locks"
    encrypt        = true
  }
}
