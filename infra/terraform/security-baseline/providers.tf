# ── Account-level security baseline (SOC 2 / Drata) ──────────────────────────
#
# Codifies the durable, account-global compliance controls that back the Drata
# Infrastructure tests. The live AWS state was first remediated via CLI on
# 2026-06-03 (see ../../compliance/SOC2-DRATA-REMEDIATION.md); this stack is the
# system-of-record going forward and is what the Drata Compliance-as-Code
# pipeline (.github/workflows/drata-compliance.yml) scans.
#
# State is isolated from the app envs (own key security/baseline.tfstate).
# One-time cleanup actions (deletion of 15 empty default VPCs, per-VPC flow logs
# + NACL deny entries) were applied via CLI. Regional account controls such as
# GuardDuty and EBS default encryption are managed here in all 17 regions.
#
# Adopt the already-live resources with `terraform plan` + the import blocks in
# imports.tf, review the (should-be-empty) diff, then `terraform apply`.

terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0"
    }
  }
}

provider "aws" {
  region = "us-west-2"
}

# CloudTrail is multi-region but homed in us-east-1; its KMS key must live there.
provider "aws" {
  alias  = "use1"
  region = "us-east-1"
}

# Every opted-in commercial region is explicit here because GuardDuty and EBS
# default encryption are regional account controls. Keeping them in Terraform
# prevents an unused region from silently drifting out of the security baseline.
provider "aws" {
  alias  = "aps1"
  region = "ap-south-1"
}

provider "aws" {
  alias  = "eun1"
  region = "eu-north-1"
}

provider "aws" {
  alias  = "euw3"
  region = "eu-west-3"
}

provider "aws" {
  alias  = "euw2"
  region = "eu-west-2"
}

provider "aws" {
  alias  = "euw1"
  region = "eu-west-1"
}

provider "aws" {
  alias  = "apne3"
  region = "ap-northeast-3"
}

provider "aws" {
  alias  = "apne2"
  region = "ap-northeast-2"
}

provider "aws" {
  alias  = "apne1"
  region = "ap-northeast-1"
}

provider "aws" {
  alias  = "cac1"
  region = "ca-central-1"
}

provider "aws" {
  alias  = "sae1"
  region = "sa-east-1"
}

provider "aws" {
  alias  = "apse1"
  region = "ap-southeast-1"
}

provider "aws" {
  alias  = "apse2"
  region = "ap-southeast-2"
}

provider "aws" {
  alias  = "euc1"
  region = "eu-central-1"
}

provider "aws" {
  alias  = "use2"
  region = "us-east-2"
}

provider "aws" {
  alias  = "usw1"
  region = "us-west-1"
}

data "aws_caller_identity" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  tags = {
    ManagedBy  = "terraform"
    Stack      = "security-baseline"
    Compliance = "soc2"
  }
}
