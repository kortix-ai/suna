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

# 2026-10-09: whatsapp-gateway was shut down and us-west-2 Bedrock invocation
# logging was turned off, so their three adopted roles left Terraform. The
# `removed` blocks drop them from state without a destroy; the roles are then
# deleted by hand (detach policies first). Delete these blocks once the
# Terraform Apply Global run that applies them has finished.
removed {
  from = aws_iam_role.bedrock_logs
  lifecycle {
    destroy = false
  }
}

removed {
  from = aws_iam_role.whatsapp_gateway_instance
  lifecycle {
    destroy = false
  }
}

removed {
  from = aws_iam_role.whatsapp_gateway_github_deploy
  lifecycle {
    destroy = false
  }
}
