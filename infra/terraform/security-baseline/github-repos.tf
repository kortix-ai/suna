locals {
  # The GitHub repository names GitHub Actions OIDC tokens may carry in `sub`.
  # GitHub writes the repository's CURRENT name into `sub`, so a rename locks
  # every role out until its trust lists the new name (2026-11-03:
  # kortix-ai/suna → kortix-ai/CompanyOS denied every dev deploy and migration).
  # The old name stays so a rename back keeps working.
  github_repos = ["kortix-ai/suna", "kortix-ai/CompanyOS"]
}
