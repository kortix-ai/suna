# ════════════════════════════════════════════════════════════════════════════
# TWO ROLES (audit finding "any ref can assume the prod-capable deploy role"):
#   kortix-gha-ecs-deploy       any ref of the repo (CI on every branch and pull
#                               request reads kortix-ci-env through it).
#   kortix-gha-ecs-deploy-prod  only a job with `environment: prod`
#                               (sub = repo:kortix-ai/suna:environment:prod).
#                               Prod ECS, prod PassRole, prod blobs. The `prod`
#                               GitHub environment admits branch `prod` only.
# PHASE 1 (this file): the prod role exists and every workflow on main uses it.
# The broad role KEEPS its prod permissions, because the workflow copies on the
# `prod` branch (rollback-prod.yml) still assume it until the next release.
# PHASE 2 (after that release): delete the prod ECS, prod PassRole, and
# kortix-prod-* secret grants from the broad role. Until then the hole is open.
# ════════════════════════════════════════════════════════════════════════════

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
#   - PassRole for the task+exec roles of all production release services:
#     kortix-{dev,staging,prod} (api), kortix-{dev,staging,prod}-gateway,
#     and kortix-{dev,staging,prod}-web
#     plus the pre-cutover US East 2 API and gateway shadow services
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
  tags = {
    ManagedBy  = "terraform"
    Name       = "kortix-gha-ecs-deploy"
    Stack      = "security-baseline"
    Compliance = "soc2"
  }
}

resource "aws_iam_role_policy" "gha_ecs_deploy" {
  # checkov:skip=CKV_AWS_355: TaskDefinitionLifecycle and
  # DescribeLoadBalancers require "*" because these APIs do not support
  # resource-level permissions; every other statement is ARN-scoped.
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
        Sid      = "DescribeKortixServices"
        Effect   = "Allow"
        Action   = ["ecs:DescribeServices"]
        Resource = ["arn:aws:ecs:*:${local.account_id}:service/kortix-*/kortix-*"]
      },
      {
        Sid    = "DescribeKortixTasks"
        Effect = "Allow"
        Action = ["ecs:DescribeTasks", "ecs:ListTasks"]
        # Tasks/list are scoped by cluster through the task/container-instance
        # ARN path; kortix clusters all match kortix-*.
        Resource = [
          "arn:aws:ecs:*:${local.account_id}:task/kortix-*/*",
          "arn:aws:ecs:*:${local.account_id}:container-instance/kortix-*/*",
        ]
        Condition = {
          ArnLike = {
            "ecs:cluster" = "arn:aws:ecs:*:${local.account_id}:cluster/kortix-*"
          }
        }
      },
      {
        # RegisterTaskDefinition/DescribeTaskDefinition do not support
        # resource-level permissions (AWS SAR table) — "*" is the only valid
        # resource for them; see the checkov skip on this resource.
        Sid    = "TaskDefinitionLifecycle"
        Effect = "Allow"
        Action = [
          "ecs:DescribeTaskDefinition",
          "ecs:RegisterTaskDefinition",
        ]
        Resource = "*"
      },
      {
        # The US shadow workflow resolves each ALB DNS name before updating its
        # Cloudflare CNAME. DescribeLoadBalancers supports no resource ARN.
        Sid      = "DescribeLoadBalancers"
        Effect   = "Allow"
        Action   = ["elasticloadbalancing:DescribeLoadBalancers"]
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
          "arn:aws:iam::${local.account_id}:role/kortix-dev-web-task",
          "arn:aws:iam::${local.account_id}:role/kortix-dev-web-exec",
          "arn:aws:iam::${local.account_id}:role/kortix-dev-use2-task",
          "arn:aws:iam::${local.account_id}:role/kortix-dev-use2-exec",
          "arn:aws:iam::${local.account_id}:role/kortix-dev-use2-gateway-task",
          "arn:aws:iam::${local.account_id}:role/kortix-dev-use2-gateway-exec",
          "arn:aws:iam::${local.account_id}:role/kortix-dev-use2-web-task",
          "arn:aws:iam::${local.account_id}:role/kortix-dev-use2-web-exec",
          "arn:aws:iam::${local.account_id}:role/kortix-staging-task",
          "arn:aws:iam::${local.account_id}:role/kortix-staging-exec",
          "arn:aws:iam::${local.account_id}:role/kortix-staging-gateway-task",
          "arn:aws:iam::${local.account_id}:role/kortix-staging-gateway-exec",
          "arn:aws:iam::${local.account_id}:role/kortix-staging-web-task",
          "arn:aws:iam::${local.account_id}:role/kortix-staging-web-exec",
          "arn:aws:iam::${local.account_id}:role/kortix-staging-euw2-task",
          "arn:aws:iam::${local.account_id}:role/kortix-staging-euw2-exec",
          "arn:aws:iam::${local.account_id}:role/kortix-staging-euw2-gateway-task",
          "arn:aws:iam::${local.account_id}:role/kortix-staging-euw2-gateway-exec",
          "arn:aws:iam::${local.account_id}:role/kortix-staging-euw2-web-task",
          "arn:aws:iam::${local.account_id}:role/kortix-staging-euw2-web-exec",
          "arn:aws:iam::${local.account_id}:role/kortix-prod-task",
          "arn:aws:iam::${local.account_id}:role/kortix-prod-exec",
          "arn:aws:iam::${local.account_id}:role/kortix-prod-gateway-task",
          "arn:aws:iam::${local.account_id}:role/kortix-prod-gateway-exec",
          "arn:aws:iam::${local.account_id}:role/kortix-prod-web-task",
          "arn:aws:iam::${local.account_id}:role/kortix-prod-web-exec",
          "arn:aws:iam::${local.account_id}:role/kortix-prod-use2-task",
          "arn:aws:iam::${local.account_id}:role/kortix-prod-use2-exec",
          "arn:aws:iam::${local.account_id}:role/kortix-prod-use2-gateway-task",
          "arn:aws:iam::${local.account_id}:role/kortix-prod-use2-gateway-exec",
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
  # tail matches Secrets Manager's random ARN suffix. The staging deployment
  # also refreshes kortix-staging-env from GitHub's staging-only data-plane
  # secrets. Keep that write grant limited to the staging blob.
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "ReadKortixEnvironmentSecrets"
        Effect = "Allow"
        Action = [
          "secretsmanager:GetSecretValue",
          "secretsmanager:DescribeSecret",
        ]
        Resource = "arn:aws:secretsmanager:*:${local.account_id}:secret:kortix-*-env-*"
      },
      {
        Sid    = "WriteStagingSecret"
        Effect = "Allow"
        Action = [
          "secretsmanager:CreateSecret",
          "secretsmanager:PutSecretValue",
        ]
        Resource = [
          "arn:aws:secretsmanager:us-west-2:${local.account_id}:secret:kortix-staging-env-*",
          "arn:aws:secretsmanager:eu-west-2:${local.account_id}:secret:kortix-staging-env-*",
        ]
      },
      {
        Sid    = "WriteWebEnvironmentSecrets"
        Effect = "Allow"
        Action = [
          "secretsmanager:CreateSecret",
          "secretsmanager:PutSecretValue",
        ]
        Resource = "arn:aws:secretsmanager:*:${local.account_id}:secret:kortix-*-web-env-*"
      },
    ]
  })
}

# ── kortix-gha-ecs-deploy-prod — prod only, reachable only from `environment: prod` ──
# The OIDC subject of a job that declares `environment: prod` is
# `repo:kortix-ai/suna:environment:prod`. A job without it (any branch, any pull
# request, any workflow_dispatch ref) gets a ref subject and cannot assume this
# role. The `prod` environment's deployment-branch policy admits branch `prod`
# only, so GitHub refuses to start the job from any other ref. Same containment
# as iam-gha-tf-apply.tf.
resource "aws_iam_role" "gha_ecs_deploy_prod" {
  name = "kortix-gha-ecs-deploy-prod"
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
          "token.actions.githubusercontent.com:sub" = "repo:kortix-ai/suna:environment:prod"
        }
      }
    }]
  })
  tags = {
    ManagedBy  = "terraform"
    Name       = "kortix-gha-ecs-deploy-prod"
    Stack      = "security-baseline"
    Compliance = "soc2"
  }
}

resource "aws_iam_role_policy" "gha_ecs_deploy_prod" {
  # checkov:skip=CKV_AWS_355: TaskDefinitionLifecycle and
  # DescribeLoadBalancers require "*" because these APIs do not support
  # resource-level permissions; every other statement is ARN-scoped.
  name = "ecs-deploy-prod"
  role = aws_iam_role.gha_ecs_deploy_prod.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "ManageProdServices"
        Effect = "Allow"
        Action = ["ecs:UpdateService", "ecs:DescribeServices"]
        # prod = eu-west-2; kortix-prod-use2* are the us-east-2 shadow services.
        Resource = ["arn:aws:ecs:*:${local.account_id}:service/kortix-prod*/kortix-prod*"]
      },
      {
        Sid    = "DescribeProdTasks"
        Effect = "Allow"
        Action = ["ecs:DescribeTasks", "ecs:ListTasks"]
        Resource = [
          "arn:aws:ecs:*:${local.account_id}:task/kortix-prod*/*",
          "arn:aws:ecs:*:${local.account_id}:container-instance/kortix-prod*/*",
        ]
        Condition = {
          ArnLike = {
            "ecs:cluster" = "arn:aws:ecs:*:${local.account_id}:cluster/kortix-prod*"
          }
        }
      },
      {
        Sid      = "TaskDefinitionLifecycle"
        Effect   = "Allow"
        Action   = ["ecs:DescribeTaskDefinition", "ecs:RegisterTaskDefinition"]
        Resource = "*"
      },
      {
        Sid      = "DescribeLoadBalancers"
        Effect   = "Allow"
        Action   = ["elasticloadbalancing:DescribeLoadBalancers"]
        Resource = "*"
      },
      {
        Sid    = "PassProdTaskRoles"
        Effect = "Allow"
        Action = ["iam:PassRole"]
        Resource = [
          "arn:aws:iam::${local.account_id}:role/kortix-prod-task",
          "arn:aws:iam::${local.account_id}:role/kortix-prod-exec",
          "arn:aws:iam::${local.account_id}:role/kortix-prod-gateway-task",
          "arn:aws:iam::${local.account_id}:role/kortix-prod-gateway-exec",
          "arn:aws:iam::${local.account_id}:role/kortix-prod-web-task",
          "arn:aws:iam::${local.account_id}:role/kortix-prod-web-exec",
          "arn:aws:iam::${local.account_id}:role/kortix-prod-use2-task",
          "arn:aws:iam::${local.account_id}:role/kortix-prod-use2-exec",
          "arn:aws:iam::${local.account_id}:role/kortix-prod-use2-gateway-task",
          "arn:aws:iam::${local.account_id}:role/kortix-prod-use2-gateway-exec",
        ]
      },
    ]
  })
}

resource "aws_iam_role_policy" "gha_ecs_deploy_prod_secrets" {
  name = "ecs-deploy-prod-secrets"
  role = aws_iam_role.gha_ecs_deploy_prod.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # kortix-ci-env stays readable so a prod job that reuses the job's AWS
        # credentials (aws-env role-to-assume: '') still reads its CI keys.
        Sid    = "ReadProdAndCiSecrets"
        Effect = "Allow"
        Action = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
        Resource = [
          "arn:aws:secretsmanager:*:${local.account_id}:secret:kortix-ci-env-*",
          "arn:aws:secretsmanager:*:${local.account_id}:secret:kortix-prod*-env-*",
        ]
      },
      {
        Sid      = "WriteProdWebSecret"
        Effect   = "Allow"
        Action   = ["secretsmanager:CreateSecret", "secretsmanager:PutSecretValue"]
        Resource = "arn:aws:secretsmanager:*:${local.account_id}:secret:kortix-prod*-web-env-*"
      },
    ]
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
