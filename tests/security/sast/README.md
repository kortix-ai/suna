# SAST — Semgrep

Static application security testing with [Semgrep](https://semgrep.dev) (OSS,
LGPL). Runs entirely from Docker — no local install.

## What it does

Scans the repo source against the Semgrep registry rulesets
(`p/default`, `p/typescript`, `p/javascript`, `p/owasp-top-ten`, `p/secrets`)
plus the repo-local rules in `semgrep.yml` (command-injection, `eval`,
disabled TLS verification, weak hashes, insecure randomness).

Output: `test-results/security/semgrep.sarif`.

## Relationship to CodeQL

This **complements** the existing GitHub CodeQL workflow
(`.github/workflows/codeql.yml`), it does not replace it:

- **CodeQL** runs in CI on PRs/schedule with deep taint dataflow analysis and
  publishes to the repo Security tab. Slow, thorough, GitHub-hosted.
- **Semgrep** runs fast, locally/in any CI, with editable pattern rules that
  encode Kortix-specific anti-patterns. Quick feedback loop and portable SARIF.

Running both gives broad-pattern + deep-dataflow coverage. Both emit SARIF so
findings can be merged into one code-scanning view.

## Run

```bash
OUT_DIR=test-results/security tests/security/sast/run.sh
# or via the orchestrator:
tests/security/run.sh --sast
```

## Tuning

- `SEMGREP_CONFIG` — space-separated list of rulesets/paths (defaults above).
  Registry paths under `/src/...` reference the repo-local ruleset.
- `SEMGREP_IMAGE` — pin a different Semgrep image/version.
- `.semgrepignore` — paths excluded from scanning.

The script exits non-zero on `ERROR`-severity findings (the quality gate).
