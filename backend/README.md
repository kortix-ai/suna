
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

**1.2 Running the Worker**

The worker processes background tasks (agent runs, memory extraction, etc.)

```bash
uv run dramatiq --processes 2 --threads 2 run_agent_background
```

You should see:
```
⚡ Dramatiq worker_timeout patched to 200ms (faster message pickup)
✅ Worker process ready, tool cache warmed
```

> **Note**: Worker timeout is patched to 200ms (vs 1000ms default) to reduce task pickup latency.
> Configure via `DRAMATIQ_WORKER_TIMEOUT` env var.

**1.3 Running the API**

```bash
uv run api.py
```

---

**2. Launching the frontend**

```bash
cd frontend
npm install
npm run dev
```

Access the app at `http://localhost:3000`
