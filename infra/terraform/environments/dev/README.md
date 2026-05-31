# dev environment — `dev-api.kortix.com`

Infrastructure for the Kortix **dev** API, as code.

| Surface | Where it runs | Managed by |
|---|---|---|
| `dev-api.kortix.com` | AWS Lightsail box `kortix-dev` (us-west-2) behind nginx blue/green, fronted by Cloudflare | **this Terraform** |
| `dev.kortix.com` (frontend) | Vercel | Vercel's own Git integration — **not** Terraform |

App code is shipped by CI (`.github/workflows/deploy-dev.yml`), not Terraform.
Terraform owns the **box, its networking, and DNS** — not the running container.

## What's here

- `module.api_host` → `../../modules/api-host` — the Lightsail instance, its
  static IP, and open ports.
- `module.dns` → `../../modules/cloudflare-dns` — the proxied `dev-api` A record
  pointing at the box's static IP.

## First-time setup (adopt the live resources — no recreation)

The box and DNS record already exist. Import them into state instead of
recreating:

```bash
cd infra/terraform/environments/dev

export AWS_PROFILE=...                       # creds for us-west-2
export TF_VAR_cloudflare_api_token=...        # = CLOUDFLARE_API_TOKEN secret
export TF_VAR_cloudflare_zone_id=$(curl -s \
  -H "Authorization: Bearer $TF_VAR_cloudflare_api_token" \
  'https://api.cloudflare.com/client/v4/zones?name=kortix.com' \
  | jq -r '.result[0].id')

./import.sh          # imports the Lightsail + Cloudflare resources
terraform plan       # expect a near-empty diff
```

## Day to day

```bash
terraform plan       # preview
terraform apply      # apply infra changes (NOT app deploys)
```

## Rebuilding the box from scratch

If the instance is lost/recycled:

```bash
terraform apply                              # recreate the Lightsail instance + IP + DNS
scp modules/api-host/scripts/bootstrap-box.sh ubuntu@<ip>:
ssh ubuntu@<ip> 'bash bootstrap-box.sh'      # docker + nginx + repo + slots
# then write apps/api/.env on the box and let CI deploy
```

## Notes

- `.terraform/`, `*.tfstate`, the lockfile, and `*.tfvars` are gitignored —
  never commit them (state/secrets + huge provider binaries).
- The Cloudflare record is **proxied** (orange cloud): Cloudflare terminates
  TLS, the box serves plain HTTP on :80. Debug the origin directly with
  `curl --resolve dev-api.kortix.com:443:<ip> -k ...` to bypass the CF edge.
