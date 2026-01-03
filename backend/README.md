
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

The worker processes background tasks (agent runs, memory extraction, etc.) using Redis Streams.

```bash
uv run python run_stream_worker.py --concurrency 48
```

You should see:
```
🚀 Starting Redis Streams Worker
✅ Worker resources initialized
📡 Consumer loop started
```

> **Note**: The worker uses Redis Streams instead of Dramatiq for near-zero latency message pickup.
> Adjust concurrency via `--concurrency` flag or `STREAM_WORKER_CONCURRENCY` env var.

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
