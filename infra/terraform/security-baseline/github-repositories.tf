# The GitHub repositories whose Actions OIDC tokens the deploy, plan and apply
# roles trust (the `sub` claim names the repository). The repository was
# renamed kortix-ai/suna -> kortix-ai/CompanyOS on 2026-11-03; a rename changes
# `sub`, and every role that pinned the old name refused every workflow
# (AssumeRoleWithWebIdentity AccessDenied) until this list held the new one.
# The old name stays trusted for the switch: drop it once no run carries it.
locals {
  github_repositories = ["kortix-ai/CompanyOS", "kortix-ai/suna"]
}
