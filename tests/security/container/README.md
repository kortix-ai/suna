# Container image scanning — Trivy image

Builds the application images from `apps/*/Dockerfile` and scans each with
[Trivy](https://github.com/aquasecurity/trivy) `image` (Apache-2.0,
`aquasec/trivy`) for OS-package + language vulnerabilities and baked-in
secrets. Docker-only.

Covers the three apps with a Dockerfile: `api`, `web`, `sandbox`.

Outputs (one SARIF per app):

- `test-results/security/trivy-image-api.sarif`
- `test-results/security/trivy-image-web.sarif`
- `test-results/security/trivy-image-sandbox.sarif`

## Run

```bash
OUT_DIR=test-results/security tests/security/container/run.sh

# scan a subset:
APPS="api web" tests/security/container/run.sh

# scan pre-built images (skip the build step):
BUILD=0 APPS="api" tests/security/container/run.sh
# or via the orchestrator:
tests/security/run.sh --container
```

Trivy runs containerized and talks to the host Docker daemon via the mounted
`docker.sock` to read the just-built images.

## Quality gate

Fails (exit 1) if any image has a `CRITICAL`/`HIGH` vulnerability. Override
with `SEVERITY`. Pin Trivy with `TRIVY_IMAGE`.
