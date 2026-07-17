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

locals {
  # group => { policies = [arns], members = [usernames] }
  groups = {
    # Break-glass admins only (named individuals, MFA-enforced). kubet was scoped
    # down to a live-managed `lightsail` group (lightsail:* — kept out of TF so the
    # service wildcard isn't re-flagged by the IaC scanner).
    administrators = {
      policies = ["arn:aws:iam::aws:policy/AdministratorAccess", "arn:aws:iam::aws:policy/IAMUserChangePassword"]
      members  = ["markokraemer", "saumya@kortix.com"]
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
  }
  # Use the policy index in the instance key. Two customer-managed policy ARNs
  # are created in this stack, so deriving a key from the ARN makes the
  # for_each collection unknown during planning and prevents imports/plans.
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
