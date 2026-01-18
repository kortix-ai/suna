# Infrastructure as Code - Terraform

Single source of truth for all Suna infrastructure: AWS Lightsail, ECS, VPC, and Cloudflare resources.

## Architecture

- **Dev/Staging**: Lightsail instances with Cloudflare Tunnels
- **Production**: Lightsail + ECS cluster with Cloudflare Worker routing

## Quick Start

### Prerequisites

- Terraform >= 1.6.6
- AWS CLI configured
- Cloudflare API token
- Terraform Cloud account (or local state)

### Setup

1. **Configure Terraform Cloud** (or use local state):
   ```bash
   cd environments/prod
   terraform init
   ```

2. **Set variables**:
   - AWS credentials (via AWS CLI or env vars)
   - Cloudflare API token: `export CLOUDFLARE_API_TOKEN="your-token"`

3. **Import existing resources**:
   ```bash
   terraform plan  # Shows what will be imported
   terraform apply # Imports and manages resources
   ```

## Directory Structure

- `modules/` - Reusable Terraform modules
- `environments/` - Environment-specific configurations
  - `dev/` - Development (Lightsail + Tunnel)
  - `staging/` - Staging (Lightsail + Tunnel)
  - `prod/` - Production (Lightsail + ECS + VPC + ALB + Cloudflare)

## Resources Managed

### AWS
- Lightsail instances (dev, staging, prod)
- ECS cluster with auto-scaling
- VPC with public/private subnets
- Application Load Balancer
- Security groups, NAT gateways, route tables

### Cloudflare
- Tunnels (one per environment)
- Worker (production router)
- DNS records

## Documentation

See [DISCOVERED_RESOURCES.md](./DISCOVERED_RESOURCES.md) for complete inventory of existing resources.
