# Security testing lane

A Docker-invoked security suite covering both **static** analysis (no running
app needed) and **dynamic** analysis (against a running target). Every tool runs
from a pinned Docker image — nothing is installed locally. All output lands in
`test-results/security/`.

Run everything static, then optionally DAST against a dedicated target:

```bash
tests/security/run.sh --static
TARGET_URL=http://host.docker.internal:8000 tests/security/run.sh --dast
# or a subset:
tests/security/run.sh --sast --deps
```

## Lanes

| Lane | Dir | Tool (OSS) | Docker image | Needs running target? | Output |
|------|-----|------------|--------------|-----------------------|--------|
| SAST | [`sast/`](sast/) | Semgrep (LGPL) | `returntocorp/semgrep:1.97.0` | No | `semgrep.sarif` |
| Dependencies | [`deps/`](deps/) | Trivy fs + OSV-Scanner (Apache-2.0) | `aquasec/trivy:0.58.0`, `ghcr.io/google/osv-scanner:v1.9.2` | No | `trivy-deps.sarif`, `trivy-deps.json`, `osv.json` |
| Secrets | [`secrets/`](secrets/) | gitleaks (MIT) | `zricethezav/gitleaks:v8.30.1` | No | `gitleaks.sarif` |
| Container | [`container/`](container/) | Trivy image (Apache-2.0) | `aquasec/trivy:0.58.0` | No (builds `apps/*/Dockerfile`) | `trivy-image-{api,web,sandbox}.sarif` |
| DAST | [`dast/`](dast/) | OWASP ZAP baseline + Schemathesis (Apache-2.0 / MIT) | `ghcr.io/zaproxy/zaproxy:2.16.0`, `schemathesis/schemathesis:3.39.5` | **Yes — `TARGET_URL`** | `zap-baseline.{html,json}`, `schemathesis-junit.xml` |
| Automated pentest | [`../pentest/`](../pentest/) | Kortix black-box adversarial probes | Bun | **Yes — `PENTEST_TARGET_URL`** | `pentest/junit.xml`, `pentest/results.json` |

Static vs dynamic: the first four lanes are **static** and safe to run anywhere
(including CI on every PR). The **DAST** lane is dynamic — it sends live,
active, fuzzing traffic and must point at a dedicated/staging/local instance.

## ⚠️ DAST safety

`tests/security/dast/` performs active scanning and high-volume fuzzing. Run it
**only against a dedicated, staging, or local target** you control. **Never**
run it against shared production or shared dev — it can mutate/delete data, trip
rate limiting and alerting, and degrade service for others. `run.sh` requires
`TARGET_URL` and refuses any URL containing `prod`/`production`, but that is a
guardrail, not a substitute for judgement. See [`dast/README.md`](dast/).

## Quality gate

The gate is **fail on CRITICAL/HIGH**:

- **Semgrep** — exits non-zero on `ERROR`-severity findings.
- **Trivy (fs + image)** — exits non-zero on `CRITICAL,HIGH` vulnerabilities
  (`SEVERITY` overridable).
- **OSV-Scanner** — exits non-zero on any matched advisory.
- **gitleaks** — exits non-zero on any committed secret.
- **DAST** — exits non-zero on ZAP findings above threshold or a failing
  Schemathesis check.

`tests/security/run.sh` aggregates per-lane results, prints a PASS/FAIL/SKIP
summary, and exits non-zero if any selected lane failed — suitable as a CI gate.
Outputs are SARIF (mergeable into GitHub code-scanning) and JUnit (CI test
reporting).

## How this maps to the existing security assets

This lane **complements** the assets already in the repo; it does not replace
them.

| Existing asset | What it does | This lane's relationship |
|----------------|--------------|--------------------------|
| **CodeQL** (`.github/workflows/codeql.yml`) | Deep taint/dataflow SAST in CI, publishes to the Security tab | The `sast/` (Semgrep) lane adds fast, portable, editable pattern rules + OWASP-Top-Ten + Kortix-specific anti-patterns. Both emit SARIF. |
| **gitleaks** (`.gitleaks.toml` + `.github/workflows/secret-scan.yml`) | Secret scan on PR commit ranges | The `secrets/` lane reuses the **same** root `.gitleaks.toml` (same rules + allowlists, same 8.30.1) so local and CI agree. |
| **.deepsec** (`.deepsec/`) | AI-assisted code scanner (LLM triage of findings) | Orthogonal: deepsec is AI-judgement-based; this lane is deterministic tool-based. Run both; cross-check findings. |
| **security-audit** (`tests/security-audit/`) | 40 hand-written adversarial integration tests (auth, JWT, CORS, injection, proxy, business-logic, cross-user) | These are app-specific assertions; the DAST lane adds generic, spec-driven black-box scanning/fuzzing on top. |
| **pentest** (`tests/pentest/`) | Enterprise automated black-box pentest lane for CI evidence | Promotes the security-audit intent into a repeatable, target-configurable release/nightly gate with JUnit/JSON artifacts. |

## Enterprise pentest evidence

For compliance, use three layers:

1. Deterministic static gates here (`make security`).
2. Dynamic automated gates against staging (`make security-dast` and `make pentest`).
3. Independent manual/external penetration test reports with remediation evidence.

The automated lanes are release/nightly controls. They are not a replacement for human-led
penetration testing, but they provide recurring evidence that known attack classes stay fixed.

## Conventions

Scripts are POSIX-ish bash and take config via env vars (image pins,
`SEVERITY`, `TARGET_URL`, etc.). No code comments; each lane has its own README.
Nothing here installs tooling or runs scanners on import — invoke a `run.sh`
explicitly.
