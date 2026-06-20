# ADR-004: Secret Management

- **Status:** Accepted
- **Date:** 2026-06-20
- **Deciders:** Platform Engineering

## Context

The Kortix API needs a large bundle of runtime secrets (Supabase, Redis, Stripe,
LLM providers, etc.) in every environment. Requirements:

- **Zero plaintext secrets in git** — no Kubernetes `Secret` manifests, no
  base64-that-isn't-encryption.
- The same secret bundle the legacy ECS task consumes must serve EKS during the
  dual-run, so there is one source of truth, not a fork.
- Pods authenticate to the cloud secret store with no static credentials.
- CI authenticates to AWS with no long-lived access keys.
- Local development can run against real-shaped secrets without anyone handling
  raw values.
- Secrets are regionally co-located with the cluster that uses them.

## Decision

Adopt a layered model: **External Secrets Operator (ESO) + AWS Secrets Manager**
in-cluster, **dotenvx-encrypted** secrets for local dev, **IRSA** for pod auth,
and **OIDC** for CI — with **no plaintext secrets committed to git**.

**In-cluster (ESO + AWS Secrets Manager).** The chart's
`templates/externalsecret.yaml` defines a `SecretStore` (provider `aws`,
`service: SecretsManager`) that authenticates via the app ServiceAccount's IRSA
role, and an `ExternalSecret` that `dataFrom.extract`s the entire JSON bundle
into one in-cluster `Secret` (`kortix-api-env`) consumed via `envFrom`. The
secret bundle never leaves AWS except as the synced Secret. Per-environment
bundles, regionally co-located:

| Env | `secretName` | Region |
|---|---|---|
| prod (`kortix-prod`) | `kortix-prod-env` | eu-west-2 |
| dev (`kortix-dev`) | `kortix-dev-env` | us-west-2 |
| preview (`kortix-pr-*`) | `kortix-preview-env` | us-west-2 |

Prod's bundle is the **same** one ECS reads, so the two runtimes stay in sync
during the dual-run. Previews share the dev data plane via `kortix-preview-env`,
trusting any `kortix-pr-*/kortix-api` ServiceAccount to read it.

**Pod auth — IRSA.** Pods assume an IAM role through the ServiceAccount's
OIDC-bound IRSA (provisioned in `modules/eks` / `irsa`); no static AWS keys live
in any pod or manifest. ESO uses this same role to read Secrets Manager.

**CI auth — OIDC.** GitHub Actions assume AWS roles via GitHub OIDC (no static
access keys in repo secrets), the same federation used for deploys and for the
supply-chain signing planned in `docs/SECURITY.md`.

**Local dev — dotenvx.** `apps/api/.env` / `apps/web/.env` are gitignored,
multi-profile (LOCAL/DEV/PROD), and dotenvx-encrypted in git; decryption keys
live in Dotenv Armor, never in the repo. Developers edit values, never wholesale-
overwrite the files.

## Rotation

Secrets Manager is the rotation point. Rotate at the source (new value in the
per-env bundle); ESO re-syncs on its `refreshInterval`, so a rotated secret
propagates to the in-cluster `Secret` without a redeploy — though pods that read
env vars at boot need a rolling restart to pick up new values (`kubectl rollout
restart`), which GitOps performs safely. Target cadence: scheduled rotation for
database/Redis/provider credentials, and immediate rotation on any suspected
exposure. IRSA and OIDC trust relationships remove long-lived cloud credentials
entirely, shrinking what must be rotated to the application-level bundle.

## Consequences

**Positive**

- No plaintext secrets in git anywhere; the bundle stays inside AWS.
- One source of truth shared by ECS and EKS through the cutover.
- No static cloud credentials — IRSA for pods, OIDC for CI.
- Rotation is a Secrets Manager change that auto-propagates via ESO.

**Negative**

- ESO is another in-cluster controller to run and monitor; if it stalls,
  `SecretSynced` goes false and new/rotated values don't land.
- Env-var-at-boot consumption means rotation isn't fully live without a rolling
  restart.
- Per-region bundles mean the same logical secret exists in two regions and must
  be kept consistent.

## Alternatives Considered

- **Plain Kubernetes Secrets in git (SealedSecrets/SOPS).** Rejected: even
  sealed, it puts ciphertext and key management in the repo and forks the source
  of truth away from the ECS-shared Secrets Manager bundle.
- **HashiCorp Vault.** More capable (dynamic secrets, fine-grained leasing) but
  a heavy new system to run; AWS Secrets Manager + ESO + IRSA already meets the
  requirements with managed infrastructure. Tracked as out-of-scope in the
  remediation plan.
- **Static IAM access keys in CI/pods.** Rejected outright — long-lived
  credentials are exactly what IRSA and OIDC eliminate.
