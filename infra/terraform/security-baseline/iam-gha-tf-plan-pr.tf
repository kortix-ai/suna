# ════════════════════════════════════════════════════════════════════════════
# kortix-gha-tf-plan-pr — the OIDC role the pull request `plan` job of
# terraform-ci.yml assumes to run a read-only `terraform plan` on the roots a
# pull request changes.
#
# WHY A SECOND ROLE: kortix-gha-tf-plan (iam-gha-tf-plan.tf) trusts only the
# main-branch subject, on purpose — pull request code must not reach an
# account-wide read role by default. A reviewer still needs to see what a
# Terraform change does before it merges and auto-applies. This role is the
# same read-only grant, reachable only through the GitHub environment
# `terraform-plan-pr`.
#
# TRUST: the subject pins the environment. A job that does not declare
# `environment: terraform-plan-pr` cannot assume the role. Give that
# environment required reviewers: an approval then stands between pull request
# code and this credential. terraform-ci.yml also runs the job only for
# branches of this repository; a fork pull request gets no OIDC token.
#
# SCOPE: ReadOnlyAccess minus secret material, identical to kortix-gha-tf-plan.
# The job runs with -lock=false, so it needs no DynamoDB write.
# ════════════════════════════════════════════════════════════════════════════
resource "aws_iam_role" "gha_tf_plan_pr" {
  name = "kortix-gha-tf-plan-pr"

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
          "token.actions.githubusercontent.com:sub" = "repo:kortix-ai/suna:environment:terraform-plan-pr"
        }
      }
    }]
  })

  tags = {
    ManagedBy  = "terraform"
    Name       = "kortix-gha-tf-plan-pr"
    Stack      = "security-baseline"
    Compliance = "soc2"
  }
}

resource "aws_iam_role_policy_attachment" "gha_tf_plan_pr_readonly" {
  role       = aws_iam_role.gha_tf_plan_pr.name
  policy_arn = "arn:aws:iam::aws:policy/ReadOnlyAccess"
}

# Same deny as kortix-gha-tf-plan: plan reads no secret value, so the role
# cannot either. Deny wins over the managed policy's allow.
resource "aws_iam_role_policy" "gha_tf_plan_pr_deny_secrets" {
  name = "deny-secret-material"
  role = aws_iam_role.gha_tf_plan_pr.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid    = "DenySecretMaterial"
      Effect = "Deny"
      Action = [
        "secretsmanager:GetSecretValue",
        "kms:Decrypt",
        "ssm:GetParameter",
        "ssm:GetParameters",
        "ssm:GetParametersByPath",
      ]
      Resource = "*"
    }]
  })
}

output "gha_tf_plan_pr_role_arn" {
  description = "Set as the repo variable TF_PLAN_PR_ROLE_ARN for the pull request plan job of terraform-ci.yml."
  value       = aws_iam_role.gha_tf_plan_pr.arn
}
