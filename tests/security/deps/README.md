# Dependency scanning — Trivy fs + OSV-Scanner

Software-composition analysis over the repo's lockfiles
(`pnpm-lock.yaml`, `package-lock.json`, `bun.lock`, etc.). Docker-only.

## Tools

- [Trivy](https://github.com/aquasecurity/trivy) `fs` (Apache-2.0,
  `aquasec/trivy`) — vulnerability + license scan. Emits SARIF (full report)
  and a gated JSON (CRITICAL/HIGH only, non-zero exit).
- [OSV-Scanner](https://github.com/google/osv-scanner) (Apache-2.0,
  `ghcr.io/google/osv-scanner`) — cross-references the OSV.dev database for a
  second source of advisories.

Outputs:

- `test-results/security/trivy-deps.sarif`
- `test-results/security/trivy-deps.json`
- `test-results/security/osv.json`

## Run

```bash
OUT_DIR=test-results/security tests/security/deps/run.sh
# or:
tests/security/run.sh --deps
```

## Quality gate

Fails (exit 1) when Trivy or OSV reports a `CRITICAL`/`HIGH` advisory.
Override the threshold with `SEVERITY=CRITICAL` (Trivy syntax). Pin tool
versions with `TRIVY_IMAGE` / `OSV_IMAGE`.
