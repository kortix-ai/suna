# CI/CD Setup - COMPLETED

## What Was Done

### 1. Branch Structure ✅
- `staging` branch created from main
- All 3 branches now protected with GitHub branch protection rules

### 2. Workflows Updated ✅
- `docker-build.yml` - Supports all 3 environments (DEV, staging, production)
- `promote-branch.yml` - Unified promotion workflow (replaces 2 old workflows)
- `e2e-api-tests.yml` - Tests for all 3 environments
- `e2e-benchmark.yml` - Benchmarks for all 3 environments

### 3. Branch Protection ✅
All branches configured with:
- Required PR reviews (1 approval)
- Required status checks: "Build, push and deploy"
- Dismiss stale reviews: enabled
- No force pushes
- No deletions
- GitHub Actions can bypass PR requirements (staging & PRODUCTION only)

### 4. Changes Committed ✅
Commit: `0814a17e2` on staging branch
Pushed to: `origin/staging`

---

## Required Manual Steps

### A. Configure GitHub Secrets

Go to: https://github.com/kortix-ai/suna/settings/secrets/actions

Add these secrets:

#### DEV Environment (NEW)
```
AWS_DEV_HOST=<your-dev-lightsail-ip>
AWS_DEV_USERNAME=ubuntu
AWS_DEV_KEY=<your-dev-ssh-private-key>
DEV_KORTIX_ADMIN_API_KEY=<your-dev-admin-api-key>
```

#### STAGING Environment (NEW)  
```
AWS_STAGING_HOST=<your-staging-lightsail-ip>
AWS_STAGING_USERNAME=ubuntu
AWS_STAGING_KEY=<your-staging-ssh-private-key>
STAGING_KORTIX_ADMIN_API_KEY=<already exists - verify it's set>
```

#### PRODUCTION Environment
```
AWS_PRODUCTION_HOST=<already exists>
AWS_PRODUCTION_USERNAME=<already exists>
AWS_PRODUCTION_KEY=<already exists>
PRODUCTION_KORTIX_ADMIN_API_KEY=<already exists>
```

### B. Provision Infrastructure

You need to set up:

1. **DEV Lightsail Instance**
   - Create new Lightsail instance (same spec as current staging)
   - Clone backend repo
   - Configure `.env` with DEV Supabase credentials
   - Install Docker & Docker Compose
   - Setup SSH key access

2. **STAGING Lightsail Instance**
   - Create new Lightsail instance (1:1 replica of production)
   - Clone backend repo
   - Configure `.env` with STAGING Supabase credentials
   - Install Docker & Docker Compose
   - Setup SSH key access

3. **Supabase Projects**
   - Create DEV Supabase project
   - Create STAGING Supabase project
   - Run migrations from `backend/supabase/migrations/`
   - Update environment variables

### C. Configure Vercel

Go to: https://vercel.com/kortix-ai/suna

Create separate deployments or configure environment variables for:

1. **DEV (main branch)**
   - Domain: `dev.kortix.com` or use preview URLs
   - Environment variables:
     - `NEXT_PUBLIC_BACKEND_URL=https://dev-api.suna.so`
     - `NEXT_PUBLIC_SUPABASE_URL=<dev-supabase-url>`
     - `NEXT_PUBLIC_SUPABASE_ANON_KEY=<dev-anon-key>`

2. **STAGING (staging branch)**
   - Domain: `staging.kortix.com`
   - Environment variables:
     - `NEXT_PUBLIC_BACKEND_URL=https://staging-api.suna.so`
     - `NEXT_PUBLIC_SUPABASE_URL=<staging-supabase-url>`
     - `NEXT_PUBLIC_SUPABASE_ANON_KEY=<staging-anon-key>`

3. **PRODUCTION (PRODUCTION branch)**
   - Domain: `app.kortix.com` / `kortix.com`
   - Already configured

---

## How It Works Now

### Deployment Flow
```
1. Push to main → Auto-deploy to DEV
2. Manual promotion: main → staging (via "Promote Branch" workflow)
3. Auto Monday 23:59 UTC: staging → PRODUCTION
```

### Manual Promotion
```bash
# Go to GitHub Actions → "Promote Branch" → Run workflow
# Select: "main → staging" or "staging → PRODUCTION"
# Type: "promote" to confirm
# Click: "Run workflow"
```

### Environment Mapping
| Branch | Environment | Backend | Frontend |
|--------|-------------|---------|----------|
| `main` | DEV | Lightsail DEV | Vercel Preview |
| `staging` | staging | Lightsail STAGING | Vercel Staging |
| `PRODUCTION` | production | Lightsail PROD | Vercel Production |

---

## Testing the Setup

1. Make a small change to main branch
2. Push to main → should trigger DEV deployment
3. Check GitHub Actions to verify deployment succeeded
4. Check DEV environment to verify changes deployed
5. Use "Promote Branch" workflow to promote to staging
6. Verify staging deployment
7. Wait for Monday 23:59 UTC or manually trigger production rollout

---

## Verification Checklist

- [x] staging branch created
- [x] Branch protection rules set for all 3 branches
- [x] Workflows updated and committed
- [ ] GitHub secrets configured
- [ ] DEV Lightsail instance provisioned
- [ ] STAGING Lightsail instance provisioned
- [ ] DEV Supabase project created
- [ ] STAGING Supabase project created
- [ ] Vercel configured for 3 environments
- [ ] Test deployment to DEV
- [ ] Test promotion to staging
- [ ] Test rollout to production

---

## Support

Branch protection URL: https://github.com/kortix-ai/suna/settings/branches
GitHub Actions URL: https://github.com/kortix-ai/suna/actions
Secrets URL: https://github.com/kortix-ai/suna/settings/secrets/actions
