
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
uv run python run_worker.py --concurrency 8
```

You should see:
```
🚀 Starting Redis Streams Worker
✅ Worker resources initialized
📡 Consumer loop started
```


**1.3 Running the API**

```bash
uv run api.py
```

---

**2. Launching the frontend**

```bash
cd frontend
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

