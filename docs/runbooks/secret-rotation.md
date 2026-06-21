# Runbook: Secret Rotation

Secrets are delivered by the **External Secrets Operator (ESO)** pulling a
per-env bundle from **AWS Secrets Manager** into a Kubernetes Secret that the API
mounts via `envFrom`. Rotation is therefore: **change the value in Secrets
Manager → let ESO (or force it to) re-sync → rolling-restart the Deployment to
pick up the new env.** Done correctly it is **zero-downtime**.

```
AWS Secrets Manager (per-env bundle)
   │  ESO ExternalSecret (refreshInterval: 1h)   ← templates/externalsecret.yaml
   ▼
K8s Secret  kortix-api-env  (targetSecretName)
   │  envFrom
   ▼
kortix-api pods   ← only re-read env on RESTART (env is injected at container start)
```

| Env | Secrets Manager source (`secretName`) | SM region | K8s Secret (`targetSecretName`) | Namespace |
|---|---|---|---|---|
| prod | `kortix-prod-env` | eu-west-2 | `kortix-api-env` | `kortix-prod` |
| dev | `kortix-dev-env` | us-west-2 | `kortix-api-env` | `kortix-dev` |
| preview | `kortix-preview-env` | us-west-2 | `kortix-api-env` | `kortix-pr-*` |

Source of truth: `infra/k8s/charts/kortix-api/templates/externalsecret.yaml`
(`refreshInterval` default **`1h`**, `values.yaml`), and the `externalSecrets`
block in each `infra/k8s/envs/<env>/values.yaml`.

> The bundle is a single JSON blob (ESO `dataFrom.extract` → one key per env
> var). The prod EKS bundle is the **same bundle ECS uses**
> (`kortix-prod-env-*`) — see `infra/EKS.md`. Edit individual keys; never
> wholesale-overwrite the blob.

---

## Procedure (zero-downtime)

Set context for the target env first.

```bash
aws eks update-kubeconfig --name kortix-prod-eks --region eu-west-2   # prod
NS=kortix-prod ; SM=kortix-prod-env ; SM_REGION=eu-west-2
```

### 1. Rotate the value in AWS Secrets Manager

Edit only the key(s) you're rotating, preserving the rest of the JSON.

```bash
# Fetch current bundle, patch one key with jq, push it back as a new version.
CUR=$(aws secretsmanager get-secret-value \
  --secret-id "$SM" --region "$SM_REGION" --query SecretString --output text)

NEW=$(printf '%s' "$CUR" | jq --arg v 'NEW_VALUE' '.SOME_API_KEY = $v')

aws secretsmanager put-secret-value \
  --secret-id "$SM" --region "$SM_REGION" --secret-string "$NEW"
```

(For credentials with a provider-side dual-validity window — e.g. API keys that
support overlapping old+new — create the new credential first so both are valid
during the roll, then revoke the old one after step 4 verifies.)

### 2. Refresh ESO (wait the interval, or force it)

ESO re-syncs every **`refreshInterval: 1h`** automatically. To apply now, force a
refresh by annotating the ExternalSecret (bumps `force-sync`):

```bash
kubectl -n "$NS" annotate externalsecret kortix-api-env \
  force-sync="$(date +%s)" --overwrite

# Confirm ESO re-synced the K8s Secret (Ready / SecretSynced=True).
kubectl -n "$NS" get externalsecret kortix-api-env
kubectl -n "$NS" describe externalsecret kortix-api-env | sed -n '/Status/,$p'
```

Verify the K8s Secret now carries the new value (base64):

```bash
kubectl -n "$NS" get secret kortix-api-env -o jsonpath='{.data.SOME_API_KEY}' \
  | base64 -d ; echo
```

### 3. Rolling-restart to pick it up

The Secret is injected via `envFrom` at container start, so **running pods keep
the old value until restarted**. A rolling restart is zero-downtime (PDB
`minAvailable: 50%` on prod + `maxUnavailable: 0` keep capacity up; dev has no
PDB on its single replica).

```bash
kubectl -n "$NS" rollout restart deploy/kortix-api
kubectl -n "$NS" rollout status  deploy/kortix-api
```

> GitOps note: `rollout restart` only patches the pod-template annotation to
> trigger a roll; it does **not** change git, so Argo CD's `selfHeal` won't
> revert it (the desired spec is unchanged — new pods just re-read the synced
> Secret). No values bump needed.

### 4. Verify

```bash
kubectl -n "$NS" get pods -o wide                     # all new pods Ready
kubectl -n "$NS" get externalsecret kortix-api-env    # SecretSynced=True
curl -fsS https://api-eks.kortix.com/v1/health | jq '{version,status}'   # prod
# Functionally exercise whatever the rotated secret gates (e.g. a call that hits
# the rotated API key) and confirm no auth errors in Loki:
#   {namespace="kortix-prod"} |= "401" or |= "auth"
```

### 5. Revoke the old credential

Only **after** step 4 confirms the new value works, revoke/disable the old
credential at the provider (and, if you kept an old SM version pinned anywhere,
drop it). This closes the rotation.

---

## Rotating the IRSA/role boundary (rare)

The pod reads Secrets Manager via its IRSA role
(`serviceAccount.roleArn`, e.g. `arn:aws:iam::935064898258:role/kortix-prod-eks-app`).
That role/trust is **Terraform-owned** (`modules/eks` / the `prod-eks/cluster`
state), not part of this runbook — change it there and `terraform apply`, then
re-run steps 2–4.

---

## Gotchas

- **No restart = no effect.** ESO updating the K8s Secret does not restart pods;
  env is only re-read on container start. Always do step 3.
- **Don't overwrite the whole bundle** — patch single keys; the bundle holds the
  full env for the API.
- **Right region.** prod SM is **eu-west-2**, dev/preview SM is **us-west-2**
  (mismatch = ESO `SecretSyncedError`).
- **Automated rotation is not yet wired.** Rotation is currently manual/scripted;
  scheduled rotation + alerting is a documented gap
  (`infra/INFRASTRUCTURE_PLAN.md` "Secret management — add rotation";
  `docs/WHATS_MISSING.md`).
