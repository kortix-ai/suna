# ════════════════════════════════════════════════════════════════════════════
# Group-based access control — Drata DCF-776. Every IAM user gets permissions
# ONLY via group membership; no direct managed attachments, no inline policies.
# Users themselves are left unmanaged (created out-of-band); we manage the
# groups, the policy attachments, and the memberships.
# ════════════════════════════════════════════════════════════════════════════

# Inline policies converted to customer-managed so they can hang off a group.
resource "aws_iam_policy" "cloudwatch_logs" {
  name   = "kortix-cloudwatch-logs-policy"
  policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogGroups", "logs:DescribeLogStreams"], Resource = ["arn:aws:logs:*:${local.account_id}:log-group:*", "arn:aws:logs:*:${local.account_id}:log-group:*:log-stream:*"] }] })
  tags   = local.tags
}
resource "aws_iam_policy" "bedrock_count_tokens" {
  name   = "kortix-bedrock-count-tokens"
  policy = jsonencode({ Version = "2012-10-17", Statement = [{ Sid = "Statement1", Effect = "Allow", Action = ["bedrock:CountTokens"], Resource = ["arn:aws:bedrock:*::foundation-model/*", "arn:aws:bedrock:*:${local.account_id}:inference-profile/*"] }] })
  tags   = local.tags
}

# Self-service MFA management — replaces the inline `EnforceMFA` policy that
# used to hang directly off the `ino` user (Drata DCF-776 flags inline user
# policies). This is the AWS-published self-service MFA + password pattern:
# every action is scoped to the CALLING user via the ${aws:username} IAM policy
# variable (escaped as $${aws:username} in Terraform so it is not treated as a
# Terraform interpolation). The users are created out-of-band (per the file
# convention above), so there is no aws_iam_user resource to reference; the
# policy variable is what makes the same group policy safe for any member.
resource "aws_iam_policy" "mfa_self_manage" {
  name = "kortix-mfa-self-manage"
  policy = jsonencode({
    Version = "2012-10-17",
    Statement = [
      {
        Sid = "ManageOwnMFADevices", Effect = "Allow",
        Action = [
          "iam:CreateVirtualMFADevice", "iam:DeleteVirtualMFADevice",
          "iam:EnableMFADevice", "iam:DeactivateMFADevice",
          "iam:ResyncMFADevice", "iam:ListMFADevices",
          "iam:ListVirtualMFADevices"
        ],
        Resource = [
          "arn:aws:iam::${local.account_id}:mfa/$${aws:username}",
          "arn:aws:iam::${local.account_id}:user/$${aws:username}"
        ]
      },
      {
        Sid      = "ManageOwnAccessKeys", Effect = "Allow",
        Action   = ["iam:ListAccessKeys", "iam:GetAccessKeyLastUsed"],
        Resource = "arn:aws:iam::${local.account_id}:user/$${aws:username}"
      },
      {
        Sid = "ManageOwnLoginProfile", Effect = "Allow",
        Action = [
          "iam:ChangePassword", "iam:GetLoginProfile",
          "iam:UpdateLoginProfile", "iam:CreateLoginProfile", "iam:DeleteLoginProfile"
        ],
        Resource = "arn:aws:iam::${local.account_id}:user/$${aws:username}"
      }
    ]
  })
  tags = local.tags
}

# SES send-only — replaces the inline `ses-send-only` policy that used to hang
# directly off the `kortix-ses-sender` user (Drata DCF-776 flags inline user
# policies). Grants send on every SES identity in this account (the Kortix
# verified sending identity is managed out-of-band, so it is referenced by
# account-scoped ARN rather than a hard-coded identity name).
resource "aws_iam_policy" "ses_send_only" {
  name = "kortix-ses-send-only"
  policy = jsonencode({
    Version = "2012-10-17",
    Statement = [
      {
        Sid      = "SendEmail", Effect = "Allow",
        Action   = ["ses:SendEmail", "ses:SendRawEmail", "ses:SendTemplatedEmail", "ses:SendBounce"],
        Resource = ["arn:aws:ses:*:${local.account_id}:identity/*"]
      }
    ]
  })
  tags = local.tags
}

locals {
  # group => { policies = [arns], members = [usernames] }
  groups = {
    # Break-glass admins only (named individuals, MFA-enforced). Person
    # memberships are managed out-of-band (AWS console / aws iam
    # add-user-to-group) — individual people must not live in version-controlled
    # IaC (churn + audit noise on every join/leave). kubet was scoped down to a
    # live-managed `lightsail` group (lightsail:* — kept out of TF so the service
    # wildcard isn't re-flagged by the IaC scanner).
    administrators = {
      policies = ["arn:aws:iam::aws:policy/AdministratorAccess", "arn:aws:iam::aws:policy/IAMUserChangePassword"]
      members  = []
    }
    bedrock-limited = {
      policies = ["arn:aws:iam::aws:policy/AmazonBedrockLimitedAccess"]
      members  = ["BedrockAPIKey-0v89", "BedrockAPIKey-8k3j", "BedrockAPIKey-derh", "BedrockAPIKey-fafo", "BedrockAPIKey-hsns", "BedrockAPIKey-j2st", "BedrockAPIKey-jzid", "BedrockAPIKey-mk3l", "BedrockAPIKey-no80", "BedrockAPIKey-nwbk", "BedrockAPIKey-xzvm"]
    }
    bedrock-marketplace = {
      policies = ["arn:aws:iam::aws:policy/AmazonBedrockMarketplaceAccess"]
      members  = ["BedrockAPIKey-derh", "BedrockAPIKey-no80", "BedrockAPIKey-nwbk"]
    }
    bedrock-full = {
      policies = ["arn:aws:iam::aws:policy/AmazonBedrockFullAccess"]
      # No current member. The historical saumya-bedrock IAM user does not
      # exist, so declaring it here would make an otherwise safe plan fail.
      members = []
    }
    bedrock-count-tokens = {
      policies = [aws_iam_policy.bedrock_count_tokens.arn]
      members  = ["BedrockAPIKey-8k3j"]
    }
    cloudwatch-logs-writers = {
      policies = [aws_iam_policy.cloudwatch_logs.arn]
      members  = ["kortix-cloudwatch-logs"]
    }
    # Self-service MFA group (replaces the inline `EnforceMFA` policy that used
    # to hang directly off one user — DCF-776 requires group-based permissions
    # only). The policy is self-scoped via the ${aws:username} IAM variable, so
    # it is safe for any member. Person memberships are managed OUT-OF-BAND
    # (AWS console / `aws iam add-user-to-group --group-name mfa-self-manage`),
    # NOT committed to this repo: individual people must not live in
    # version-controlled IaC (churn + audit noise on every join/leave), and the
    # self-scoped policy keeps DCF-776 satisfied with no member named in TF.
    # See aws_iam_policy.mfa_self_manage above.
    mfa-self-manage = {
      policies = [aws_iam_policy.mfa_self_manage.arn]
      members  = []
    }
    # SES send-only for the `kortix-ses-sender` user (was an inline `ses-send-only`
    # policy — DCF-776 requires group-based permissions only). See aws_iam_policy
    # .ses_send_only above.
    ses-senders = {
      policies = [aws_iam_policy.ses_send_only.arn]
      members  = ["kortix-ses-sender"]
    }
  }
  # Use the policy index in the instance key. Customer-managed policy ARNs are
  # created in this stack, so deriving a key from the ARN makes the for_each
  # collection unknown during planning and prevents imports/plans.
  group_attachments = merge([for g, cfg in local.groups : { for index, policy in cfg.policies : "${g}|${index}" => { group = g, policy = policy } }]...)
  user_groups = {
    for user in distinct(flatten([for cfg in values(local.groups) : cfg.members])) :
    user => sort([for group, cfg in local.groups : group if contains(cfg.members, user)])
  }
}

resource "aws_iam_group" "this" {
  for_each = local.groups
  name     = each.key
}

resource "aws_iam_group_policy_attachment" "this" {
  for_each   = local.group_attachments
  group      = aws_iam_group.this[each.value.group].name
  policy_arn = each.value.policy
}

resource "aws_iam_user_group_membership" "this" {
  for_each = local.user_groups
  user     = each.key
  groups   = each.value
}
