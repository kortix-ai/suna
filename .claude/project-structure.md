# Project Structure

Monorepo with the following structure:

```
agentpress/
├── apps/
│   ├── frontend/     # Next.js frontend (Vercel)
│   └── mobile/       # React Native app (Expo)
├── backend/          # Python FastAPI (AWS Lightsail + ECS)
├── packages/
│   └── shared/       # Shared TypeScript code
└── infra/            # Pulumi infrastructure as code
```

## Tech Stack

| Component | Technology | Hosting |
|-----------|------------|---------|
| Frontend | Next.js 14 | Vercel |
| Backend | FastAPI (Python) | AWS Lightsail + ECS |
| Mobile | React Native + Expo | App Store / Play Store |
| Database | PostgreSQL | Supabase |
| Cache | Redis | Upstash / Local |
| IaC | Pulumi (TypeScript) | AWS |
