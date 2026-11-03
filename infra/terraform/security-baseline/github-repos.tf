locals {
  # The repository identities GitHub Actions OIDC tokens may carry in `sub`
  # (`repo:<identity>:<context>`).
  #
  # This repository issues IMMUTABLE subjects (`use_immutable_subject`, see
  # `gh api repos/kortix-ai/CompanyOS/actions/oidc/customization/sub`):
  # `sub` names the owner and repository by id, `kortix-ai@170767358/CompanyOS@868173144`,
  # and survives a rename. 2026-11-03: the rename kortix-ai/suna → kortix-ai/CompanyOS
  # switched `sub` to that form, and every role that trusted only names refused
  # every workflow (AssumeRoleWithWebIdentity AccessDenied), deploys included.
  # The name forms stay for a repository that issues name-based subjects.
  github_repos = [
    "kortix-ai@170767358/CompanyOS@868173144",
    "kortix-ai/CompanyOS",
    "kortix-ai/suna",
  ]
}
