# Environments

## Overview

| Environment | Git Branch | Frontend | Backend API |
|-------------|------------|----------|-------------|
| **DEV** | `main` | dev.kortix.com | dev-api.kortix.com |
| **STAGING** | `staging` | staging.kortix.com | staging-api.kortix.com |
| **PRODUCTION** | `PRODUCTION` | kortix.com | api.kortix.com |

## Databases (Supabase)

| Environment | Project |
|-------------|---------|
| DEV | heprlhlltebrxydgtsjs |
| STAGING | ujzsbwvurfyeuerxxeaz |
| PRODUCTION | jbriwassebxdwoieikga |

## Promotion Flow

```
main (DEV) → staging (STAGING) → PRODUCTION
```

Use GitHub Actions "Promote Branch" workflow to promote between environments.
