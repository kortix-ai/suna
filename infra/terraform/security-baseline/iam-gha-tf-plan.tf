# ════════════════════════════════════════════════════════════════════════════
# kortix-gha-tf-plan — the OIDC role the scheduled drift-detection job assumes
# (terraform-ci.yml, job "drift detection").
#
# WHY: the job has been gated on the repo variable TF_PLAN_ROLE_ARN since it
# was written, and that variable never existed — so it resolved to "skipping",
# which renders green in the checks list. A change-management control that has
# never executed is worse than no control, because the dashboard says it ran.
#
# SCOPE: `terraform plan` has to read every resource a root manages, so this is
# necessarily account-wide read. It is read-only (ReadOnlyAccess) and the
# inline policy then subtracts the parts of "read" that are really data
# exfiltration: secret values, parameter decryption, and KMS decrypt. Plan does
# not need any of them — no drift-matrix root reads a secret at plan time, and
# the state bucket is SSE-S3 (AES256), so state access does not touch KMS.
#
# The job runs with -lock=false, so no DynamoDB write is required.
# ════════════════════════════════════════════════════════════════════════════

resource "aws_iam_role" "gha_tf_plan" {
  name = "kortix-gha-tf-plan"
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
        }
        StringLike = {
          "token.actions.githubusercontent.com:sub" = "repo:kortix-ai/suna:*"
        }
      }
    }]
  })
  tags = {
    ManagedBy  = "terraform"
    Name       = "kortix-gha-tf-plan"
    Stack      = "security-baseline"
    Compliance = "soc2"
  }
}

resource "aws_iam_role_policy_attachment" "gha_tf_plan_readonly" {
  role       = aws_iam_role.gha_tf_plan.name
  policy_arn = "arn:aws:iam::aws:policy/ReadOnlyAccess"
}

# ReadOnlyAccess includes secret and key-material reads. Drift detection never
# needs them, and a CI credential that can read every secret in the account is
# a far bigger exposure than the drift it reports on. Deny wins over the
# managed policy's allow.
resource "aws_iam_role_policy" "gha_tf_plan_deny_secrets" {
  name = "deny-secret-material"
  role = aws_iam_role.gha_tf_plan.id
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

output "gha_tf_plan_role_arn" {
  description = "Set as the repo variable TF_PLAN_ROLE_ARN for terraform-ci.yml."
  value       = aws_iam_role.gha_tf_plan.arn
}
