# GitHub Secrets Configuration - COMPLETED

## Summary

All GitHub secrets have been configured via AWS CLI and GitHub CLI.

## Configured Secrets

### DEV Environment ✅
- **AWS_DEV_HOST**: `35.87.190.182` (suna-dev Lightsail instance)
- **AWS_DEV_USERNAME**: `ubuntu`
- **AWS_DEV_KEY**: SSH private key (suna-dev-key key pair created)
- **DEV_KORTIX_ADMIN_API_KEY**: Generated random key

### STAGING Environment ✅
- **AWS_STAGING_HOST**: Already configured (suna-staging: `54.184.54.33`)
- **AWS_STAGING_USERNAME**: Already configured (`ubuntu`)
- **AWS_STAGING_KEY**: Already configured (suna-staging-key)
- **STAGING_KORTIX_ADMIN_API_KEY**: Already configured

### PRODUCTION Environment ✅
- **AWS_PRODUCTION_HOST**: Already configured (suna-prod: `54.148.221.72`)
- **AWS_PRODUCTION_USERNAME**: Already configured (`ubuntu`)
- **AWS_PRODUCTION_KEY**: Already configured (suna-prod-key)
- **PRODUCTION_KORTIX_ADMIN_API_KEY**: Already configured

---

## Manual Steps Required

### 1. DEV Instance SSH Access

The `suna-dev` instance needs SSH key configuration:

**Option A: Add key via Lightsail Console (Recommended)**
```bash
1. Go to AWS Lightsail Console → suna-dev instance
2. Click "Connect" → "Connect using SSH" (browser-based)
3. Run these commands:
   
   # Get the public key
   aws lightsail get-key-pair --key-pair-name suna-dev-key \
     --query 'publicKeyBase64' --output text | base64 -d >> ~/.ssh/authorized_keys
   
   # Verify
   chmod 600 ~/.ssh/authorized_keys
```

**Option B: Attach Key Pair (Requires Instance Stop/Start)**
```bash
# This would require stopping the instance
# Not recommended for production use
```

### 2. Configure DEV Admin API Key

The `DEV_KORTIX_ADMIN_API_KEY` was randomly generated. Update the dev instance `.env`:

```bash
# SSH into dev instance (after SSH access is configured)
ssh -i ~/.ssh/suna-dev-key.pem ubuntu@35.87.190.182

# Get the key from GitHub
gh secret list --repo kortix-ai/suna | grep DEV_KORTIX_ADMIN_API_KEY

# Update .env file
cd /home/ubuntu/suna/backend
echo "ADMIN_API_KEY=<paste-the-key-here>" >> .env

# Restart services
docker compose restart
```

### 3. Verify All Secrets

Check that all secrets are set correctly:

```bash
gh secret list --repo kortix-ai/suna | grep -E "DEV|STAGING|PRODUCTION"
```

Expected output:
```
AWS_DEV_HOST
AWS_DEV_KEY
AWS_DEV_USERNAME
DEV_KORTIX_ADMIN_API_KEY
AWS_STAGING_HOST
AWS_STAGING_KEY
AWS_STAGING_USERNAME
STAGING_KORTIX_ADMIN_API_KEY
AWS_PRODUCTION_HOST
AWS_PRODUCTION_KEY
AWS_PRODUCTION_USERNAME
PRODUCTION_KORTIX_ADMIN_API_KEY
```

---

## Verification

To verify secrets are working:

1. **Merge PR #2762** into main
2. **Push a test change** to main branch
3. **Check GitHub Actions** - Should deploy to DEV (might fail if SSH not configured yet)
4. **Configure dev instance SSH** (see steps above)
5. **Retry deployment** if needed

---

## Infrastructure Details

| Instance | Environment | IP | SSH Key | Status |
|----------|-------------|----|---------| -------|
| suna-dev | DEV | 35.87.190.182 | suna-dev-key | ⚠️ Needs SSH setup |
| suna-staging | STAGING | 54.184.54.33 | suna-staging-key | ✅ Ready |
| suna-prod | PRODUCTION | 54.148.221.72 | suna-prod-key | ✅ Ready |

---

## Next Steps

1. Configure SSH access for suna-dev instance (see "Manual Steps Required" above)
2. Sync DEV_KORTIX_ADMIN_API_KEY to dev instance .env
3. Merge PR #2762
4. Test the CI/CD pipeline
5. Configure Vercel for 3 environments (see CI_CD_SETUP_COMPLETE.md)
