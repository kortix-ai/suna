# ════════════════════════════════════════════════════════════════════════════
# kortix-gha-tf-apply-{dev,staging,prod,global} — the OIDC roles that
# .github/workflows/terraform-apply.yml assumes to run `terraform apply` in CI.
#
# WHY: before these existed, deploy-prod-us-east-2-shadow.yml was the only
# workflow in the repository that applied Terraform. Every other root was
# applied by hand, so merged infrastructure could sit unapplied indefinitely —
# on 2026-08-10 two merged compliance PRs (#6295, #6344) did exactly that.
#
# TRUST: the GitHub environment is part of the OIDC subject, so a workflow that
# does not declare `environment: <name>` cannot assume the matching role. This
# is the same containment the prod-use2 bootstrap role uses
# (iam-gha-prod-use2-terraform.tf). The environment name alone is not enough,
# because it says nothing about which branch ran: terraform-apply.yml therefore
# refuses to mint credentials unless the checked-out commit is reachable from
# its required `trusted_branch` (dev -> main, staging -> staging, prod -> prod,
# infra-global -> main). Set the matching deployment-branch restriction on each
# environment as well.
#
# PERMISSIONS: PowerUserAccess plus a narrow inline IAM grant, matching the
# prod-use2 role. PowerUserAccess covers everything a root builds (VPC, ECS,
# ALB, KMS, S3, ACM, WAF, Lambda, CloudWatch, autoscaling, DynamoDB state lock)
# and excludes IAM, Organizations, and Account. The env roles get IAM write on
# their own `kortix-<env>-*` task and execution roles only.
# ════════════════════════════════════════════════════════════════════════════

locals {
  # environment name => IAM role-name prefix the root is allowed to manage.
  # environments/dev + dev-web create kortix-dev-*, kortix-dev-web-*,
  # kortix-dev-gateway-*; staging and prod follow the same shape.
  gha_tf_apply_envs = {
    dev     = "kortix-dev-"
    staging = "kortix-staging-"
    prod    = "kortix-prod-"
  }
}

resource "aws_iam_role" "gha_tf_apply" {
  for_each = local.gha_tf_apply_envs

  name = "kortix-gha-tf-apply-${each.key}"

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
          "token.actions.githubusercontent.com:sub" = "repo:kortix-ai/suna:environment:${each.key}"
        }
      }
    }]
  })

  tags = {
    ManagedBy  = "terraform"
    Name       = "kortix-gha-tf-apply-${each.key}"
    Stack      = "security-baseline"
    Compliance = "soc2"
  }
}

# checkov:skip=CKV_AWS_274: The environment-scoped OIDC trust plus the inline IAM
# policy below constrain this role. PowerUserAccess is what a full environment
# root needs (VPC, ECS, ALB, KMS, S3, ACM, WAF, autoscaling) and it excludes IAM.
resource "aws_iam_role_policy_attachment" "gha_tf_apply_power_user" {
  for_each = local.gha_tf_apply_envs

  role       = aws_iam_role.gha_tf_apply[each.key].name
  policy_arn = "arn:aws:iam::aws:policy/PowerUserAccess"
}

# The ecs-api module creates the task role, the execution role, and (since
# #6295) the SES sender policy on the task role. PowerUserAccess denies IAM, so
# grant exactly those actions, only on this environment's own role prefix.
resource "aws_iam_role_policy" "gha_tf_apply_iam" {
  for_each = local.gha_tf_apply_envs

  name = "tf-apply-${each.key}-iam"
  role = aws_iam_role.gha_tf_apply[each.key].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "ManageOnlyThisEnvironmentTaskRoles"
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
          "arn:aws:iam::${local.account_id}:role/${each.value}*",
        ]
      },
    ]
  })
}

# ── Account-global roots: compliance-monitoring + security-baseline ──────────
#
# These two roots are not environment infrastructure. They manage the account
# security baseline itself: IAM roles that are NOT kortix-<env>-* prefixed
# (whatsapp-gateway-*, bedrock-logs, vpc-flow-logs-role), IAM groups and their
# memberships, the account password policy, CloudTrail, GuardDuty in 17 regions,
# the S3 account public-access block, WAF, and the compliance Lambdas.
#
# `iam:*` on `*` would be the easy grant and the wrong one: it is
# admin-equivalent, because a caller that can attach a policy to a role it
# controls can grant itself anything. Instead every IAM principal these two
# roots manage is enumerated below. A newly named role fails the apply with an
# explicit AccessDenied rather than silently widening the grant — which is the
# correct failure mode for the stack that defines the account's security
# controls.
#
# Containment on top of that: the OIDC subject is pinned to
# `environment:infra-global` (restrict that environment to the `main` deployment
# branch), terraform-apply-global.yml runs only on push to main, and the Deny at
# the end blocks minting a long-lived human credential that would outlive the
# workflow run.
resource "aws_iam_role" "gha_tf_apply_global" {
  name = "kortix-gha-tf-apply-global"

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
          "token.actions.githubusercontent.com:sub" = "repo:kortix-ai/suna:environment:infra-global"
        }
      }
    }]
  })

  tags = {
    ManagedBy  = "terraform"
    Name       = "kortix-gha-tf-apply-global"
    Stack      = "security-baseline"
    Compliance = "soc2"
  }
}

# checkov:skip=CKV_AWS_274: PowerUserAccess is what compliance-monitoring and
# security-baseline need outside IAM (CloudTrail, GuardDuty, KMS, S3, WAF,
# Lambda, EventBridge, Backup) and it explicitly excludes IAM. The IAM half is
# the enumerated, resource-scoped inline policy below.
resource "aws_iam_role_policy_attachment" "gha_tf_apply_global_power_user" {
  role       = aws_iam_role.gha_tf_apply_global.name
  policy_arn = "arn:aws:iam::aws:policy/PowerUserAccess"
}

locals {
  # Every IAM role the two account-global roots declare, by ARN pattern.
  # Cross-check when adding an aws_iam_role to either root: an unlisted name
  # makes `terraform apply` fail with AccessDenied.
  gha_tf_apply_global_roles = [
    # kortix-gha-*, kortix-guardduty-event-forwarder
    "arn:aws:iam::${local.account_id}:role/kortix-*",
    # compliance-monitoring: KortixEc2CpuAlarmReconciler
    "arn:aws:iam::${local.account_id}:role/Kortix*",
    # compliance-monitoring manages the DrataSNSSubscriptionInspection inline
    # policy ON Drata's role (first global-apply run 403'd on GetRolePolicy).
    "arn:aws:iam::${local.account_id}:role/DrataAutopilotRole",
    # legacy-roles.tf
    "arn:aws:iam::${local.account_id}:role/whatsapp-gateway-*",
    # bedrock-logs lives under an IAM path — role/bedrock-logs does NOT match
    # (second global-apply run 403'd on GetRole). qa-portal is a legacy import.
    "arn:aws:iam::${local.account_id}:role/service-role/bedrock-logs",
    "arn:aws:iam::${local.account_id}:role/qa-portal",
    # main.tf service-delivery roles
    "arn:aws:iam::${local.account_id}:role/cloudtrail-cloudwatch-logs-role",
    "arn:aws:iam::${local.account_id}:role/vpc-flow-logs-role",
    "arn:aws:iam::${local.account_id}:role/AWSBackupDefaultServiceRole",
  ]

  # Derived from iam-groups.tf so the two never drift apart.
  gha_tf_apply_global_groups = [
    for group in keys(local.groups) :
    "arn:aws:iam::${local.account_id}:group/${group}"
  ]
  gha_tf_apply_global_users = [
    for user in keys(local.user_groups) :
    "arn:aws:iam::${local.account_id}:user/${user}"
  ]
}

resource "aws_iam_role_policy" "gha_tf_apply_global_iam" {
  name = "tf-apply-global-iam"
  role = aws_iam_role.gha_tf_apply_global.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat([
      {
        Sid    = "ManageBaselineRoles"
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
          "iam:ListRoleTags",
          "iam:PassRole",
          "iam:PutRolePolicy",
          "iam:TagRole",
          "iam:UntagRole",
          "iam:UpdateAssumeRolePolicy",
          "iam:UpdateRole",
          "iam:UpdateRoleDescription",
        ]
        Resource = local.gha_tf_apply_global_roles
      },
      {
        # GuardDuty, WAF, Backup, and Config create their own service-linked
        # roles on first use in a region.
        Sid      = "CreateServiceLinkedRoles"
        Effect   = "Allow"
        Action   = ["iam:CreateServiceLinkedRole"]
        Resource = "arn:aws:iam::${local.account_id}:role/aws-service-role/*"
      },
      {
        Sid    = "ManageBaselineCustomerPolicies"
        Effect = "Allow"
        Action = [
          "iam:CreatePolicy",
          "iam:CreatePolicyVersion",
          "iam:DeletePolicy",
          "iam:DeletePolicyVersion",
          "iam:GetPolicy",
          "iam:GetPolicyVersion",
          "iam:ListEntitiesForPolicy",
          "iam:ListPolicyVersions",
          "iam:TagPolicy",
          "iam:UntagPolicy",
        ]
        Resource = "arn:aws:iam::${local.account_id}:policy/kortix-*"
      },
      {
        Sid    = "ManageBaselineGroups"
        Effect = "Allow"
        Action = [
          "iam:AddUserToGroup",
          "iam:AttachGroupPolicy",
          "iam:CreateGroup",
          "iam:DeleteGroup",
          "iam:DeleteGroupPolicy",
          "iam:DetachGroupPolicy",
          "iam:GetGroup",
          "iam:GetGroupPolicy",
          "iam:ListAttachedGroupPolicies",
          "iam:ListGroupPolicies",
          "iam:PutGroupPolicy",
          "iam:RemoveUserFromGroup",
        ]
        Resource = local.gha_tf_apply_global_groups
      },
      {
        Sid      = "ReadGitHubOidcProvider"
        Effect   = "Allow"
        Action   = ["iam:GetOpenIDConnectProvider"]
        Resource = data.aws_iam_openid_connect_provider.github_actions.arn
      },
      {
        # checkov:skip=CKV_AWS_355: IAM account-level actions have no
        # resource-level permission — AWS requires "*" for the password policy
        # and the account-wide List/Get calls Terraform makes while refreshing.
        # The action list is closed and grants no write outside the password
        # policy.
        Sid    = "AccountLevelIamControls"
        Effect = "Allow"
        Action = [
          "iam:DeleteAccountPasswordPolicy",
          "iam:GetAccountPasswordPolicy",
          "iam:GetAccountSummary",
          "iam:ListAccountAliases",
          "iam:ListGroups",
          "iam:ListOpenIDConnectProviders",
          "iam:ListPolicies",
          "iam:ListRoles",
          "iam:ListUsers",
          "iam:UpdateAccountPasswordPolicy",
        ]
        Resource = "*"
      },
      {
        # Belt and braces over the closed action lists above: no root here mints
        # a human credential, and that is the one escalation that keeps working
        # after the workflow run ends.
        Sid    = "DenyLongLivedCredentialMinting"
        Effect = "Deny"
        Action = [
          "iam:CreateAccessKey",
          "iam:CreateLoginProfile",
          "iam:CreateServiceSpecificCredential",
          "iam:CreateUser",
          "iam:DeleteUser",
          "iam:DeleteVirtualMFADevice",
          "iam:ResetServiceSpecificCredential",
          "iam:UpdateAccessKey",
          "iam:UpdateLoginProfile",
          "iam:UploadSSHPublicKey",
          "iam:UploadSigningCertificate",
        ]
        Resource = "*"
      },
      ],
      # aws_iam_user_group_membership reads a user's current groups before it
      # reconciles them. It never creates or modifies the user. Emitted
      # conditionally: an IAM statement with an empty Resource list is a
      # MalformedPolicyDocument, and iam-groups.tf's member lists can legitimately
      # empty out (memberships are managed out-of-band).
      length(local.gha_tf_apply_global_users) == 0 ? [] : [
        {
          Sid      = "ReadBaselineGroupMembers"
          Effect   = "Allow"
          Action   = ["iam:GetUser", "iam:ListGroupsForUser"]
          Resource = local.gha_tf_apply_global_users
        },
    ])
  })
}

output "gha_tf_apply_role_arn_dev" {
  description = "Set as the repo variable TF_APPLY_ROLE_ARN_DEV (deploy-dev.yml)."
  value       = aws_iam_role.gha_tf_apply["dev"].arn
}

output "gha_tf_apply_role_arn_staging" {
  description = "Set as the repo variable TF_APPLY_ROLE_ARN_STAGING (deploy-staging.yml)."
  value       = aws_iam_role.gha_tf_apply["staging"].arn
}

output "gha_tf_apply_role_arn_prod" {
  description = "Set as the repo variable TF_APPLY_ROLE_ARN_PROD (deploy-prod.yml)."
  value       = aws_iam_role.gha_tf_apply["prod"].arn
}

output "gha_tf_apply_role_arn_global" {
  description = "Set as the repo variable TF_APPLY_ROLE_ARN_GLOBAL (terraform-apply-global.yml)."
  value       = aws_iam_role.gha_tf_apply_global.arn
}
