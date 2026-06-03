# ── Account-level security baseline (SOC 2 / Drata) ──────────────────────────
#
# Codifies the durable, account-global compliance controls that back the Drata
# Infrastructure tests. The live AWS state was first remediated via CLI on
# 2026-06-03 (see ../../compliance/SOC2-DRATA-REMEDIATION.md); this stack is the
# system-of-record going forward and is what the Drata Compliance-as-Code
# pipeline (.github/workflows/drata-compliance.yml) scans.
#
# State is isolated from the app envs (own key security/baseline.tfstate).
# Region-spanning / one-time actions (GuardDuty in all 17 regions, deletion of
# 15 empty default VPCs, per-VPC flow logs + NACL deny entries) were applied via
# CLI — see README.md for why and how to reconcile.
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

data "aws_caller_identity" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  tags = {
    ManagedBy  = "terraform"
    Stack      = "security-baseline"
    Compliance = "soc2"
  }
}
