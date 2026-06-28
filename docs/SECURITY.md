# Security Policy

This document describes the security posture, supported versions, and
vulnerability disclosure process for the `suna-eks-migration` platform — the
Kortix API running on EKS (prod `kortix-prod-eks` in eu-west-2, dev
`kortix-dev-eks` in us-west-2), deployed via Argo CD GitOps, with Supabase as the
external database.

## Supported Versions

The platform ships one version number for the whole product (the repo-root
`VERSION` file; see `infra/CICD.md`). Releases are cut as `vX.Y.Z` GitHub
Releases off the `prod` branch.

| Version | Supported |
|---|---|
| Latest `vX.Y.Z` release (current `prod`) | Yes — security fixes |
| Previous minor | Best-effort until superseded |
| Older / pre-release / `dev-latest` | No |

Security fixes are delivered through the normal release flow: patched on `main`
(dev), promoted or PR'd to `staging`, then promoted to `prod` through the
reviewed release PR. Retag-don't-rebuild means the exact bytes validated on
staging are what ship to prod.

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Report privately to the security contact:

> **security@kortix.com** — _PLACEHOLDER: this mailbox must be created and
> monitored before this policy is published externally._

Please include affected version/commit, reproduction steps, impact, and any PoC.

- **Acknowledgement:** within 3 business days.
- **Triage & severity assessment:** within 5 business days.
- **Coordinated disclosure:** we agree a disclosure timeline with the reporter,
  default 90 days or sooner once a fix ships. Critical issues are expedited.
- We credit reporters who request it after a fix is released.

## Disclosure & Patch Process

1. Report received at the security contact and acknowledged.
2. Triaged and severity-rated (CVSS); a private tracking issue is opened.
3. Fix developed and merged to `main`, exercised on dev, then promoted or PR'd to
   `staging` for release-candidate validation.
4. Promoted to `prod` (`promote` opens the release PR from staging; merge triggers
   `deploy-prod`), Argo CD rolls EKS. Affected secrets are rotated (see ADR-004)
   if exposure is suspected.
5. A `vX.Y.Z` release and advisory are published; reporter credited.

## Security Controls In Place

- **OIDC AWS authentication** — GitHub Actions assume AWS roles via OIDC; no
  static cloud access keys in the repo. Pods authenticate to AWS via **IRSA**.
- **External Secrets Operator + AWS Secrets Manager** — runtime secrets are
  synced from per-env Secrets Manager bundles (`kortix-prod-env` eu-west-2,
  `kortix-dev-env` / `kortix-preview-env` us-west-2); **zero plaintext secrets in
  git** (ADR-004).
- **dotenvx** — local-dev `.env` files are encrypted in git; keys live in Dotenv
  Armor, never the repo.
- **gitleaks** — secret scanning on every PR (`secret-scan.yml`).
- **CodeQL** — SAST on push/PR to `main`/`staging`/`prod` and weekly (`codeql.yml`).
- **GuardDuty** — AWS threat detection on account `935064898258`.
- **CloudTrail** — API-level audit logging.
- **AWS Backup** — managed backups of stateful AWS resources.
- **GitOps least privilege** — Argo CD AppProjects (`kortix`, `platform`,
  `preview`) whitelist source repos and destination namespaces, bounding blast
  radius; `selfHeal` auto-reverts drift.
- **Network isolation** — EKS runs in an isolated VPC (`10.30.0.0/16`, 3 AZ),
  nodes in private subnets; the `ops.kortix.com` admin console is Cloudflare-
  Access gated with the ALB locked to Cloudflare IPs.

## Security Controls Planned

Tracked in `docs/INFRASTRUCTURE_PLAN.md` (Waves 1–5), staged dev-first and
audit-before-enforce:

- **Trivy image scanning** — CRITICAL-severity gate in the deploy pipeline plus a
  weekly `security-scan.yml` (Trivy + Checkov/tfsec, SARIF upload).
- **cosign signing + SBOM** — syft-generated SBOM, cosign keyless sign/attest via
  GitHub OIDC, SLSA provenance on every prod image.
- **Kyverno admission control** — Kubernetes-native policies (digest pin,
  registry allow-list, require limits/labels, non-root), plus `generate`d
  default-deny NetworkPolicy + PDB per namespace; ships in Audit, then Enforce
  (ADR-002).
- **PodSecurityAdmission `restricted`** + hardened `securityContext` on all pods.
- **Falco** — runtime threat detection streamed to SIEM/Slack.
- **NetworkPolicy default-deny** — explicit allow-lists for kube-dns, Supabase,
  and Secrets Manager.
- **Velero** — cluster backup + cross-region DR for prod with restore drills.

## Supply-Chain Target: SLSA Level 3

The target is **SLSA Level 3** — signed provenance produced by a trusted builder
(GitHub OIDC) for every production container image. The platform is currently at
Level 0–1 (builds exist; no attestation). Reaching L3 is gated on the cosign +
SBOM + provenance work above.
