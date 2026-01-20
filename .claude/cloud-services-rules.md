# Cloud Services Interaction Rules

**Always prefer direct API/CLI interaction over manual dashboard instructions.**

When tasks require interaction with cloud services, proactively ask for API keys/credentials and use CLI tools or APIs directly to complete the task end-to-end.

## Supported Services

| Service | Credentials Needed | Tool |
|---------|-------------------|------|
| **AWS** | `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` | `aws` CLI |
| **Cloudflare** | `CF_API_KEY` + `CF_EMAIL` or `CF_API_TOKEN` | REST API |
| **GitHub** | Pre-authenticated | `gh` CLI |
| **Vercel** | Pre-authenticated | `vercel` CLI |
| **Supabase** | Project URL + service role key | REST API |
| **Pulumi** | `PULUMI_ACCESS_TOKEN` | `pulumi` CLI |

## Workflow

1. **Identify** what cloud operations are needed
2. **Ask** for any missing credentials
3. **Execute** directly via CLI/API - never tell user to "go to dashboard"
4. **Verify** the changes were applied

## Example Prompts

```
"To configure Cloudflare, I need:
- CF_API_KEY (Global API Key)
- CF_EMAIL (Account email)"
```

```
"To deploy to AWS, I need:
- AWS_ACCESS_KEY_ID
- AWS_SECRET_ACCESS_KEY"
```

## Security

- Never commit credentials to git
- Use GitHub secrets for CI/CD
- Prefer scoped API tokens over global keys
