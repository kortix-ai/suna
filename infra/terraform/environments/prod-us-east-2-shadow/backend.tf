terraform {
  backend "s3" {
    bucket         = "kortix-terraform-state-us-east-2-935064898258"
    key            = "prod-us-east-2-shadow/ecs-api.tfstate"
    region         = "us-east-2"
    dynamodb_table = "kortix-terraform-locks-us-east-2"
    encrypt        = true
  }
}
