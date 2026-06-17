# Secret scanning — gitleaks

Scans the working tree (or git history) for committed credentials with
[gitleaks](https://github.com/gitleaks/gitleaks) (OSS, MIT). Docker-only.

Reuses the repo's root [`.gitleaks.toml`](../../../.gitleaks.toml) — the same
config (default rules + the dotenvx-encrypted-env and i18n-key allowlists) used
in CI, so local and CI results match.

Output: `test-results/security/gitleaks.sarif`.

## Relationship to the existing workflow

This is a local mirror of the CI job in
[`.github/workflows/secret-scan.yml`](../../../.github/workflows/secret-scan.yml),
which scans PR commit ranges on `main`/`prod`. Both consume the same
`.gitleaks.toml` and pin gitleaks 8.30.1. CI gates PRs; this lets you scan
before pushing and as part of the full `tests/security/run.sh` lane.

GitHub's native secret scanning + push protection remain the third layer for
known provider patterns.

## Run

```bash
OUT_DIR=test-results/security tests/security/secrets/run.sh

# scan full git history instead of the working tree:
GITLEAKS_MODE=git tests/security/secrets/run.sh

# or via the orchestrator:
tests/security/run.sh --secrets
```

## Quality gate

Any finding fails the scan (exit 1). Findings are redacted in the report.
