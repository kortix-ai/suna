# DevOps gateway — `devops.kortix.com`

The consolidated internal control plane. One ALB, one host, one edge gate —
**supersedes `ops.kortix.com`** (the per-tool ALB described in
`infra/GITOPS.md`).

## Architecture

```
*.kortix.com user
      │  (browser)
      ▼
Cloudflare (proxied, Full strict)
   └─ Cloudflare Access  ── single edge gate: @kortix.com allow ──┐
      │                                                           │ (JWT)
      ▼                                                           │
ALB  (group.name: kortix-devops, internet-facing, HTTPS:443,     │
      ACM cert devops.kortix.com, inbound-cidrs = Cloudflare IPs) ◄┘
      │  path routing (shared listener)
      ├─ /          → Headlamp   (kortix-platform ns)
      ├─ /argo      → Argo CD    (argocd ns, argo-cd-argocd-server:80)
      ├─ /grafana   → Grafana    (monitoring ns, kube-prometheus-stack)
      └─ /cost      → OpenCost   (cost/monitoring ns)
```

- **One ALB.** Every ingress joins it via
  `alb.ingress.kubernetes.io/group.name: kortix-devops`. The AWS Load Balancer
  Controller merges them into a single ALB with one HTTPS:443 listener and
  path-based rules.
- **TLS** is terminated at the ALB with the `devops.kortix.com` ACM cert
  (`module.acm_devops`, validated via Cloudflare DNS). Backends speak plain HTTP
  (`backend-protocol: HTTP`); Argo CD therefore runs `--insecure`.
- **Edge gate.** The only public way in is Cloudflare. Cloudflare Access
  authenticates every request (`@kortix.com`) before it reaches the ALB, and the
  ALB's `inbound-cidrs` are locked to Cloudflare's published ranges so the gate
  can't be bypassed via the raw ALB DNS name.

## Bring-up order (make it LIVE)

Do these in order so the gateway is never reachable unauthenticated.

1. **Terraform — apply the cert.** In
   `infra/terraform/environments/prod-eks/cluster`:
   ```bash
   terraform apply   # creates module.acm_devops, validates via Cloudflare DNS
   terraform output -raw devops_certificate_arn
   ```

2. **Set the cert ARN into the ingress annotations.** Replace
   `REPLACE_WITH_DEVOPS_ACM_ARN` with the ARN from step 1 in:
   - `infra/k8s/platform/gateway/argocd-ingress.yaml`
   - the Grafana, Headlamp and OpenCost ingress values (each joins
     `group.name: kortix-devops` with its own path and the SAME cert ARN).

   Commit so Argo CD (`kortix-platform-gateway` + the per-tool apps) syncs them.
   The shared ALB comes up; `devops.kortix.com` does NOT resolve yet.

3. **Cloudflare Access** (Zero Trust dashboard → Access → Applications → Add):
   - Type **Self-hosted**, Application domain `devops.kortix.com`.
   - Policy: **Allow**, Include → *Emails ending in* `@kortix.com` (or a group).
   - (Optional) a shorter session duration for an admin surface.

4. **Add the DNS record.** Proxied CNAME `devops.kortix.com` → the shared ALB
   hostname:
   ```bash
   kubectl -n argocd get ingress argocd-server \
     -o jsonpath='{.status.loadBalancer.ingress[0].hostname}'
   ```
   Now `devops.kortix.com` resolves AND is gated.

5. **Retire `ops.kortix.com`.** Once `devops.kortix.com/argo` is verified:
   - Delete the `ops.kortix.com` Cloudflare DNS record and its Access app.
   - Tear down the old per-tool Argo CD ALB / ingress and remove the
     `argocd_ui_enabled` path (the `acm_argocd` cert / `argocd_domain` can be
     dropped on a later cleanup pass).

## Notes

- Argo CD must run with `--rootpath /argo` + `--insecure`. That comes from
  `infra/k8s/platform/gateway/argocd-cmd-params-cm.yaml`; restart the server
  after it syncs: `kubectl -n argocd rollout restart deploy/argo-cd-argocd-server`.
- CLI through the gateway uses gRPC-Web:
  `argocd login devops.kortix.com --grpc-web` (the gRPC path lives under the
  same host).
- This runbook supersedes the `ops.kortix.com` section of `infra/GITOPS.md`.
