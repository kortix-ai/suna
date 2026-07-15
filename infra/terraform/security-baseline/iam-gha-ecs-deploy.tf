# ════════════════════════════════════════════════════════════════════════════
# kortix-gha-ecs-deploy — the GitHub Actions OIDC role every CI ECS roll assumes
# (infra/scripts/ecs-deploy.sh via deploy-dev.yml / deploy-gateway-dev.yml /
# deploy-staging.yml / deploy-prod.yml).
#
# HISTORY / WHY THIS LIVES HERE: the role was created out-of-band and then
# hand-patched whenever it fell behind — most recently on the night of
# v0.10.0/v0.10.1 (2026-07-14/15), when the prod deploy-ecs job failed twice on
# IAM while the release announced anyway: the policy was missing the eu-west-2
# (prod) resources, the staging PassRole pair, and the GATEWAY task/exec roles
# (the prod gateway task-def that night had to be registered manually by a
# human). This file is the system-of-record for the CORRECTED policy:
#   - ECS resources region-wildcarded (dev/staging = us-west-2, prod = eu-west-2)
#   - PassRole for the task+exec roles of ALL SIX services:
#     kortix-{dev,staging,prod} (api) and kortix-{dev,staging,prod}-gateway
#     (the ecs-api TF module names roles "<service>-exec"/"<service>-task")
#   - Secrets Manager read of every kortix-<env>-env blob (the task-def renderer
#     wires each blob key as a container secret)
# Reconciled with the live role on 2026-07-16 (the missing gateway PassRole
# ARNs were added live the same day). Adopt with the import blocks below —
# `terraform plan` must show an empty diff; if it doesn't, live drifted again
# and THIS file wins.
# ════════════════════════════════════════════════════════════════════════════

data "aws_iam_openid_connect_provider" "github_actions" {
  url = "https://token.actions.githubusercontent.com"
}

resource "aws_iam_role" "gha_ecs_deploy" {
  name = "kortix-gha-ecs-deploy"
  # Any ref of the canonical repo may assume the role: dev deploys run from
  # `main` and `gateway`, staging from `staging`, prod from `prod`.
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
}

resource "aws_iam_role_policy" "gha_ecs_deploy" {
  name = "ecs-deploy"
  role = aws_iam_role.gha_ecs_deploy.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "UpdateKortixServices"
        Effect = "Allow"
        Action = ["ecs:UpdateService"]
        # Region-wildcarded: dev/staging ECS run in us-west-2, prod in eu-west-2.
        # cluster name == service name for every kortix ECS service.
        Resource = ["arn:aws:ecs:*:${local.account_id}:service/kortix-*/kortix-*"]
      },
      {
        Sid    = "DescribeAndRegister"
        Effect = "Allow"
        Action = [
          "ecs:DescribeServices",
          "ecs:DescribeTasks",
          "ecs:ListTasks",
          "ecs:DescribeTaskDefinition",
          "ecs:RegisterTaskDefinition",
        ]
        # These ECS actions don't support resource-level scoping.
        Resource = "*"
      },
      {
        Sid    = "PassTaskRoles"
        Effect = "Allow"
        Action = ["iam:PassRole"]
        # register-task-definition passes each service's exec+task role. BOTH
        # service kinds per env: the api services (kortix-<env>) AND the gateway
        # services (kortix-<env>-gateway) — omitting the gateway pair is exactly
        # what broke the v0.10.x prod gateway roll.
        Resource = [
          "arn:aws:iam::${local.account_id}:role/kortix-dev-task",
          "arn:aws:iam::${local.account_id}:role/kortix-dev-exec",
          "arn:aws:iam::${local.account_id}:role/kortix-dev-gateway-task",
          "arn:aws:iam::${local.account_id}:role/kortix-dev-gateway-exec",
          "arn:aws:iam::${local.account_id}:role/kortix-staging-task",
          "arn:aws:iam::${local.account_id}:role/kortix-staging-exec",
          "arn:aws:iam::${local.account_id}:role/kortix-staging-gateway-task",
          "arn:aws:iam::${local.account_id}:role/kortix-staging-gateway-exec",
          "arn:aws:iam::${local.account_id}:role/kortix-prod-task",
          "arn:aws:iam::${local.account_id}:role/kortix-prod-exec",
          "arn:aws:iam::${local.account_id}:role/kortix-prod-gateway-task",
          "arn:aws:iam::${local.account_id}:role/kortix-prod-gateway-exec",
        ]
      },
    ]
  })
}

resource "aws_iam_role_policy" "gha_ecs_deploy_secrets" {
  name = "ecs-deploy-secrets-read"
  role = aws_iam_role.gha_ecs_deploy.id
  # ecs-deploy.sh reads the per-env blob to render every key into the task-def
  # as a container secret. Region-wildcarded like the ECS statements; the `-*`
  # tail matches Secrets Manager's random ARN suffix.
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "secretsmanager:GetSecretValue",
        "secretsmanager:DescribeSecret",
      ]
      Resource = "arn:aws:secretsmanager:*:${local.account_id}:secret:kortix-*-env-*"
    }]
  })
}

# ── One-shot adoption of the live role (created out-of-band) ──────────────────
# Delete these blocks after the first clean `terraform plan`.
import {
  to = aws_iam_role.gha_ecs_deploy
  id = "kortix-gha-ecs-deploy"
}
import {
  to = aws_iam_role_policy.gha_ecs_deploy
  id = "kortix-gha-ecs-deploy:ecs-deploy"
}
import {
  to = aws_iam_role_policy.gha_ecs_deploy_secrets
  id = "kortix-gha-ecs-deploy:ecs-deploy-secrets-read"
}
