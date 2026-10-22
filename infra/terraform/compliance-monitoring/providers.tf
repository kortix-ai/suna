terraform {
  required_version = ">= 1.5"
  required_providers {
    archive = {
      source  = "hashicorp/archive"
      version = ">= 2.4"
    }
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0"
    }
  }
}

provider "aws" {
  region = "us-west-2"
}

provider "aws" {
  alias  = "euw2"
  region = "eu-west-2"
}

provider "aws" {
  alias  = "use2"
  region = "us-east-2"
}

data "aws_caller_identity" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  # Drata's IaC scan (test 8028) does not resolve local.tags or merge() on KMS,
  # S3, SNS, IAM role, EC2 and DynamoDB resources. Those resources repeat this
  # map as a literal; keep the copies identical.
  tags = {
    ManagedBy  = "terraform"
    Stack      = "compliance-monitoring"
    Compliance = "soc2"
  }
}
