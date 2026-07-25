terraform {
  backend "s3" {
    bucket         = "kortix-terraform-state"
    key            = "prod-us-west-2-shadow/ecs-api.tfstate"
    region         = "us-west-2"
    dynamodb_table = "kortix-terraform-locks"
    encrypt        = true
  }
}
