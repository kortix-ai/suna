# ════════════════════════════════════════════════════════════════════════════
# Roles that existed in the account but in no Terraform state.
#
# The 2026-07-29 inventory found 29 such roles. 21 were dead (last used on or
# before 2026-04-07, when the old EKS/ECS estate was retired) and were deleted
# along with 4 orphaned instance profiles and 3 unattached policies. These are
# the survivors that are genuinely in use, adopted here so the account has no
# IAM principal without a source of truth.
#
# Deliberately NOT adopted:
#   - DrataAutopilotRole: created and rotated by Drata's own integration.
#     Managing it here would fight the vendor.
#   - kortix-enterprise-publisher-terraform: the role the enterprise publisher
#     Terraform assumes. A root cannot own the credential it runs as.
# ════════════════════════════════════════════════════════════════════════════

import {
  to = aws_iam_role.bedrock_logs
  id = "bedrock-logs"
}

import {
  to = aws_iam_role.whatsapp_gateway_instance
  id = "whatsapp-gateway-instance"
}

import {
  to = aws_iam_role.whatsapp_gateway_github_deploy
  id = "whatsapp-gateway-github-deploy"
}
