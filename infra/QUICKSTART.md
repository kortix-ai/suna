# Terraform Infrastructure - Quick Start Guide

## Overview

This Terraform configuration manages all Suna infrastructure as a single source of truth:
- AWS Lightsail instances (dev, staging, prod)
- AWS ECS cluster with auto-scaling (prod)
- AWS VPC with networking (prod)
- Cloudflare Tunnels (all environments)
- Cloudflare Worker for production routing

## Prerequisites

1. **Terraform >= 1.6.6** (use `tfenv` or download from hashicorp.com)
2. **AWS CLI configured** with appropriate credentials
3. **Cloudflare API token** with admin permissions
4. **Terraform Cloud account** (or use local state)

## Initial Setup

### 1. Create Terraform Cloud Organization

1. Go to https://app.terraform.io
2. Create organization: `kortix`
3. Create workspaces:
   - `suna-dev`
   - `suna-staging`
   - `suna-prod`

### 2. Configure Workspace Variables

For each workspace, add these variables:

**Environment Variables:**
- `AWS_ACCESS_KEY_ID` (sensitive)
- `AWS_SECRET_ACCESS_KEY` (sensitive)
- `CLOUDFLARE_API_TOKEN` (sensitive)

**Terraform Variables:**
- `cloudflare_account_id` = `9785405a992435bb0c7bd19f9b6d26d5`
- `cloudflare_zone_id` = `af378d3df4e4dd5052a1fcbf263b685d` (kortix.com)

### 3. Initialize and Import

Start with the **dev** environment (simplest):

```bash
cd environments/dev
terraform init
terraform plan  # Review what will be imported
terraform apply # Import existing resources
```

After successful import, verify:
```bash
terraform plan  # Should show NO CHANGES
```

Repeat for `staging` and `prod` environments.

## Import Process

The `imports.tf` files in each environment contain import blocks for existing resources. When you run `terraform apply`, Terraform will:

1. Import all existing resources into state
2. Verify the configuration matches reality
3. Show any differences (should be minimal)

## Common Commands

```bash
# Initialize
terraform init

# Plan changes
terraform plan

# Apply changes
terraform apply

# Show current state
terraform show

# List resources
terraform state list

# Remove resource from state (if needed)
terraform state rm <resource_address>
```

## Troubleshooting

### Import Errors

If an import fails:
1. Check the resource ID format in `imports.tf`
2. Verify the resource exists in AWS/Cloudflare
3. Check IAM permissions

### State Mismatches

If `terraform plan` shows unexpected changes:
1. Review the diff carefully
2. Update the Terraform configuration to match reality
3. Re-run `terraform plan` until no changes

### Missing Resources

If a resource isn't imported:
1. Add it to the appropriate `imports.tf`
2. Run `terraform plan` to see the import
3. Run `terraform apply` to import it

## Next Steps

After successful import:
1. ✅ Verify `terraform plan` shows NO CHANGES
2. ✅ Update CI/CD to use Terraform
3. ✅ Delete old Pulumi code (if any remains)
4. ✅ Document any manual steps in runbooks

## Architecture Reference

See [DISCOVERED_RESOURCES.md](./DISCOVERED_RESOURCES.md) for complete inventory of existing resources.
