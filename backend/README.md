
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

**NOTE: Worker process removed** - Agent runs now execute directly in the API process as async background tasks. Memory/categorization tasks also run directly.

No separate worker process needed - just run the API:
```bash
uv run python api.py
```
📡 Consumer loop started
```


**1.3 Running the API**

```bash
uv run api.py
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

