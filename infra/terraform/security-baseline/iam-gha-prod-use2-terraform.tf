# Dedicated GitHub Actions role for the pre-cutover US East 2 production
# Terraform root. The GitHub environment is part of the OIDC subject. This
# prevents workflows without that environment from assuming this role.
resource "aws_iam_role" "gha_prod_use2_terraform" {
  name = "kortix-gha-prod-use2-terraform"

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
          "token.actions.githubusercontent.com:sub" = "repo:kortix-ai/suna:environment:prod-use2-shadow"
        }
      }
    }]
  })

  tags = {
    ManagedBy  = "terraform"
    Name       = "kortix-gha-prod-use2-terraform"
    Stack      = "security-baseline"
    Compliance = "soc2"
  }
}

# checkov:skip=CKV_AWS_274: The environment-scoped OIDC trust and the inline IAM
# policy below constrain this one production bootstrap role. PowerUserAccess is
# required for the VPC, ECS, ALB, KMS, S3, ACM, and autoscaling resources.
resource "aws_iam_role_policy_attachment" "gha_prod_use2_power_user" {
  role       = aws_iam_role.gha_prod_use2_terraform.name
  policy_arn = "arn:aws:iam::aws:policy/PowerUserAccess"
}

resource "aws_iam_role_policy" "gha_prod_use2_iam" {
  name = "prod-use2-terraform-iam"
  role = aws_iam_role.gha_prod_use2_terraform.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "ManageOnlyUse2TaskRoles"
        Effect = "Allow"
        Action = [
          "iam:AttachRolePolicy",
          "iam:CreateRole",
          "iam:DeleteRole",
          "iam:DeleteRolePolicy",
          "iam:DetachRolePolicy",
          "iam:GetRole",
          "iam:GetRolePolicy",
          "iam:ListAttachedRolePolicies",
          "iam:ListRolePolicies",
          "iam:PassRole",
          "iam:PutRolePolicy",
          "iam:TagRole",
          "iam:UntagRole",
          "iam:UpdateAssumeRolePolicy",
          "iam:UpdateRole",
          "iam:UpdateRoleDescription",
        ]
        Resource = [
          "arn:aws:iam::${local.account_id}:role/kortix-prod-use2-*",
        ]
      },
    ]
  })
}
