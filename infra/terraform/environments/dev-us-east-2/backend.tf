# Remote state in the SAME S3 bucket + DynamoDB lock table every other
# ECS-API root uses (kortix-terraform-state / kortix-terraform-locks, both
# us-west-2 — the state backend's OWN region is independent of the region the
# resources inside the state live in; ../prod proves this today: its state
# lives in this us-west-2 bucket while every resource it describes is in
# eu-west-2). A distinct KEY is all that is required to give this root its own
# state; no new bucket/table bootstrap is needed.
terraform {
  backend "s3" {
    bucket         = "kortix-terraform-state"
    key            = "dev-us-east-2/ecs-api.tfstate"
    region         = "us-west-2"
    dynamodb_table = "kortix-terraform-locks"
    encrypt        = true
  }
}
