# Suna Infrastructure

Unified Pulumi Infrastructure-as-Code for all Suna environments.

## Architecture

```
                    ┌─────────────────────────────────────────────────────────┐
                    │                    CLOUDFLARE                            │
                    │                                                          │
                    │   api.kortix.com ──► Worker (api-kortix-router)          │
                    │                          │                               │
                    │         ┌────────────────┴────────────────┐              │
                    │         ▼                                 ▼              │
                    │   ACTIVE_BACKEND=lightsail          (future: ecs)        │
                    │         │                                 │              │
                    │         ▼                                 ▼              │
                    │   api-lightsail.kortix.com         api-ecs.kortix.com    │
                    │   (Tunnel f4125d84)                (Direct to ALB)       │
                    └─────────┬─────────────────────────────────┬──────────────┘
                              │                                 │
                              ▼                                 ▼
┌─────────────────────────────────────────┐    ┌───────────────────────────────────┐
│         LIGHTSAIL (Prod)                │    │           ECS (Prod)              │
│   suna-prod: 54.148.221.72              │    │   Cluster: suna-ecs               │
│   128GB RAM, 32 vCPU                    │    │   4 tasks on 3 instances          │
│   Cloudflared → localhost:8000          │    │   ALB → Target Group → Tasks      │
└─────────────────────────────────────────┘    └───────────────────────────────────┘

┌─────────────────────────────────────────┐    ┌───────────────────────────────────┐
│         LIGHTSAIL (Dev)                 │    │         LIGHTSAIL (Staging)       │
│   suna-dev: 35.87.190.182               │    │   suna-staging: 54.184.54.33      │
│   8GB RAM, 2 vCPU                       │    │   8GB RAM, 2 vCPU                 │
│   Tunnel → dev-api.kortix.com           │    │   Tunnel → staging-api.kortix.com │
└─────────────────────────────────────────┘    └───────────────────────────────────┘
```

## Directory Structure

```
infra/
├── components/           # Shared reusable components
│   ├── lightsail/       # Lightsail instance component
│   ├── cloudflare/      # Cloudflare DNS, Tunnel, Worker components
│   └── index.ts         # Common configs and exports
├── environments/         # Environment-specific stacks
│   ├── dev/             # DEV environment (Lightsail only)
│   ├── staging/         # STAGING environment (Lightsail only)
│   └── prod/            # PROD environment (ECS + Lightsail + Worker router)
├── package.json
├── tsconfig.json
└── README.md
```

## Environments

| Environment | Infrastructure | API Endpoint | Resources |
|-------------|---------------|--------------|-----------|
| **dev** | Lightsail | dev-api.kortix.com | Lightsail (8GB/2vCPU), Cloudflare Tunnel |
| **staging** | Lightsail | staging-api.kortix.com, staging-api.suna.so | Lightsail (8GB/2vCPU), Cloudflare Tunnel |
| **prod** | ECS + Lightsail | api.kortix.com | Full VPC, ECS cluster, ALB, Lightsail (128GB/32vCPU), Cloudflare Worker Router |

## Quick Start

### Prerequisites

1. Install Pulumi CLI: `curl -fsSL https://get.pulumi.com | sh`
2. Install Bun: `curl -fsSL https://bun.sh/install | bash`
3. Configure AWS credentials: `aws configure`
4. Set Cloudflare credentials:
   ```bash
   export CLOUDFLARE_API_KEY="your-api-key"
   export CLOUDFLARE_EMAIL="your-email"
   ```

### Install Dependencies

```bash
cd infra
bun install
```

### Deploy an Environment

```bash
# DEV
cd environments/dev
pulumi up

# STAGING
cd environments/staging
pulumi up

# PROD
cd environments/prod
pulumi up
```

## Configuration

Each environment uses Pulumi config for customization:

### Dev/Staging (Lightsail + Tunnel)

No additional configuration needed - uses defaults.

### Prod (Full Infrastructure)

```bash
cd environments/prod

# Switch between Lightsail and ECS backend
pulumi config set activeBackend lightsail  # or ecs

# Container image
pulumi config set ghcrImage ghcr.io/kortix-ai/suna/suna-backend:prod

# ECS instance type
pulumi config set ecsInstanceType r6a.xlarge

# Enable HTTPS (requires ACM certificate validation)
pulumi config set enableHttps true
```

## Resources Created

### Dev Environment
- Lightsail Instance (suna-dev)
- Cloudflare Tunnel
- DNS Record (dev-api.kortix.com)

### Staging Environment
- Lightsail Instance (suna-staging) with Static IP
- Cloudflare Tunnel
- DNS Records (staging-api.kortix.com, staging-api.suna.so)

### Prod Environment

**AWS:**
- VPC (10.20.0.0/16) with 3 public + 3 private subnets
- Internet Gateway + 3 NAT Gateways
- Security Groups (ALB, ECS Tasks)
- Application Load Balancer
- ECS Cluster with Auto Scaling
- IAM Roles (ECS Instance, Task Execution, Task)
- Secrets Manager
- CloudWatch Log Groups + Alarms
- SNS Topic for Alerts
- S3 Bucket for ALB Logs
- ACM Certificate (*.kortix.com)
- Lightsail Instance (suna-prod, 128GB/32vCPU)

**Cloudflare:**
- Tunnel (PRODUCTION API Lightsail)
- Worker (api-kortix-router) for traffic routing
- DNS Records (api.kortix.com, api-lightsail.kortix.com, api-ecs.kortix.com)

## Cloudflare Credentials

The infrastructure requires Cloudflare Global API Key (not API Token):

```bash
export CLOUDFLARE_API_KEY="your-global-api-key"
export CLOUDFLARE_EMAIL="your-email@example.com"
```

Find your Global API Key at: https://dash.cloudflare.com/profile/api-tokens

## Tunnel Setup on Instances

After deploying, set up cloudflared on each Lightsail instance:

```bash
# SSH into instance
ssh -i <key>.pem ubuntu@<ip>

# Install cloudflared
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o cloudflared.deb
sudo dpkg -i cloudflared.deb

# Get tunnel token from Pulumi
pulumi stack output tunnelToken --show-secrets

# Configure cloudflared
sudo cloudflared service install <token>
sudo systemctl enable cloudflared
sudo systemctl start cloudflared
```

## Switching Production Backend

Production uses a Cloudflare Worker to route traffic between Lightsail and ECS:

```bash
cd environments/prod

# Switch to ECS
pulumi config set activeBackend ecs
pulumi up

# Switch back to Lightsail
pulumi config set activeBackend lightsail
pulumi up
```

The Worker adds `X-Backend` header to responses indicating which backend served the request.

## Outputs

Each environment exports useful information:

```bash
# View all outputs
pulumi stack output

# View specific output
pulumi stack output publicIpAddress

# View secrets
pulumi stack output tunnelToken --show-secrets
```

## Migrating from Terraform

This infrastructure replaces the previous Terraform setup in `infra-terraform/`. All resources are now managed by Pulumi:

- Terraform state should be backed up before migration
- Resources may need to be imported if not recreating
- Use `pulumi import` for existing resources

## Troubleshooting

### Cloudflare Authentication

If you get authentication errors:
1. Ensure you're using Global API Key, not API Token
2. Verify email matches your Cloudflare account
3. Check environment variables are exported

### Tunnel Not Connecting

1. Verify tunnel token is correct
2. Check cloudflared service status: `sudo systemctl status cloudflared`
3. View cloudflared logs: `sudo journalctl -u cloudflared -f`

### ECS Tasks Not Starting

1. Check CloudWatch logs: `/ecs/suna-api`
2. Verify secrets exist in Secrets Manager
3. Check security group rules allow traffic
