
**0. Launching with Docker (Manual)**

You can manually launch all Suna services using Docker Compose from the project root:

```bash
# From project root directory
cd /path/to/suna
```

**0.1 Start all services**

```bash
# Start all services (Redis, Backend, Frontend, Worker)
docker compose up -d

# Or start specific services
docker compose up -d redis backend frontend
```

**0.2 Start services individually**

```bash
# Start Redis only
docker compose up -d redis

# Start Backend (depends on Redis)
docker compose up -d backend

# Start Frontend (depends on Backend)
docker compose up -d frontend

# Start Worker (optional, for background tasks)
docker compose up -d worker
```

**0.3 View logs**

```bash
# View all logs
docker compose logs -f

# View specific service logs
docker compose logs -f backend
docker compose logs -f frontend
docker compose logs -f redis
```

**0.4 Stop services**

```bash
# Stop all services
docker compose down

# Stop and remove volumes           
docker compose down -v
```

**0.5 Check status**

```bash
# Check running containers
docker compose ps

# Check all containers (including stopped)
docker compose ps -a
```

**Access points:**
- Frontend: http://localhost:3000
- Backend API: http://localhost:8000
- Redis: localhost:6379

---

**1. Launching the backend**

```bash
cd backend
```

**1.1 Launching Redis**

```bash
# Option A: Use Docker
docker compose up redis

# Option B: Run locally (if installed)
redis-server
```


**1.3 Running the API**

```bash
cd backend && uv run api.py
```

---

**2. Launching the frontend**

```bash
cd apps/frontend
pnpm install
pnpm run dev
```

Access the app at `http://localhost:3000`

## Build Verification

Run `make verify` or `uv run python core/utils/scripts/verify_build.py` to check:
- All imports work
- No syntax errors
- No undefined names
- API can be imported
- Worker can be imported

See `core/utils/scripts/README.md` for more details on available scripts.

