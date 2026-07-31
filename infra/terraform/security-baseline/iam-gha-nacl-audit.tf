# ════════════════════════════════════════════════════════════════════════════
# kortix-gha-nacl-audit — the OIDC role the scheduled NACL admin-port audit
# assumes (terraform-ci.yml, job "nacl admin-port audit").
#
# WHY A DEDICATED ROLE: the audit only needs to list regions and read network
# ACLs. It deliberately does NOT reuse TF_PLAN_ROLE_ARN, which the drift job
# consumes — that job runs `terraform plan` against whole roots and needs broad
# read plus state access. Pointing both at one narrow role would light up drift
# detection with permissions it cannot work with; pointing both at one broad
# role would hand a read-everything credential to a job that needs two calls.
#
# The audit reads deployed reality rather than Terraform state on purpose:
# Terraform only governs the VPCs it creates, so hand-edited ACLs, imported
# VPCs and newly-opened regions are exactly the cases that need catching. That
# is why the permissions are account-wide but read-only.
# ════════════════════════════════════════════════════════════════════════════

resource "aws_iam_role" "gha_nacl_audit" {
  name = "kortix-gha-nacl-audit"
  # Pinned to the default branch. qa-pr.yml runs on pull_request with
  # id-token: write and executes PR-controlled code, so a wildcard subject
  # would let any pull request mint a token and assume this role. The audit
  # runs on schedule and manual dispatch, both of which carry the main subject.
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Federated = data.aws_iam_openid_connect_provider.github_actions.arn
      }
      Action = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          "token.actions.githubusercontent.com:sub" = "repo:kortix-ai/suna:ref:refs/heads/main"
        }
      }
    }]
  })
  tags = {
    ManagedBy  = "terraform"
    Name       = "kortix-gha-nacl-audit"
    Stack      = "security-baseline"
    Compliance = "soc2"
  }
}

resource "aws_iam_role_policy" "gha_nacl_audit" {
  # checkov:skip=CKV_AWS_355: DescribeRegions and DescribeNetworkAcls are
  # account-wide describes; neither API supports resource-level permissions.
  # checkov:skip=CKV_AWS_290: Read-only describes; the policy grants no writes.
  name = "nacl-admin-port-audit"
  role = aws_iam_role.gha_nacl_audit.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid    = "ReadNetworkAcls"
      Effect = "Allow"
      Action = [
        "ec2:DescribeRegions",
        "ec2:DescribeNetworkAcls",
      ]
      Resource = "*"
    }]
  })
}

output "gha_nacl_audit_role_arn" {
  description = "Set as the repo variable NACL_AUDIT_ROLE_ARN for terraform-ci.yml."
  value       = aws_iam_role.gha_nacl_audit.arn
}
