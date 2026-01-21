# CI/CD Workflows

## GitHub Actions Workflows

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| **Build and Deploy** | Push to main/staging/PRODUCTION | Build Docker image, deploy to target env |
| **Promote Branch** | Manual | Promote main→staging or staging→PRODUCTION |
| **E2E API Tests** | After deployment | Run E2E tests against deployed environment |
| **Sync PROD DB** | Manual | Dump PROD database to staging/dev |

## Common Commands

```bash
# Promote main to staging
gh workflow run "Promote Branch" -f promotion="main → staging" -f confirm="promote"

# Promote staging to production
gh workflow run "Promote Branch" -f promotion="staging → PRODUCTION" -f confirm="promote"

# Sync PROD DB to staging
gh workflow run "Sync PROD DB to Lower Environment" -f target_environment="staging" -f confirm="sync"

# Run E2E tests manually
gh workflow run "E2E API Tests" -f environment="dev"
```

## Deployment Flow

1. Push to `main` → Builds & deploys to DEV
2. Run "Promote Branch" → Promotes to STAGING
3. Run "Promote Branch" → Promotes to PRODUCTION
4. E2E tests run automatically after each deployment
