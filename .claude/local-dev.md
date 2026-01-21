# Local Development

## Prerequisites

- Node.js 20+
- Bun
- Python 3.11+
- Docker & Docker Compose
- uv (Python package manager)

## Running Locally

### Backend

```bash
cd backend
cp .env.example .env  # Configure environment variables
docker compose up
```

API available at: http://localhost:8000

### Frontend

```bash
cd apps/frontend
bun install
bun dev
```

App available at: http://localhost:3000

### Mobile

```bash
cd apps/mobile
bun install
bun start
```

## Infrastructure (Pulumi)

```bash
cd infra
bun install
pulumi up --stack dev
```
