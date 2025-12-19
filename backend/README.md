
**1. Launching the backend**

```
cd /backend
```

1.1 Launching REDIS for data caching


```bash
docker compose up redis
```


1.2 Running Dramatiq worker for thread execution

**IMPORTANT**: Always specify `--processes` to control worker count. Without it, Dramatiq defaults to CPU count (often 8-12), which creates too many Redis connections!

```bash
uv run dramatiq --processes 2 --threads 2 run_agent_background
```

1.3 Running the main server

```bash
uv run api.py
```

**2. Launching the frontend**

```bash

cd frontend && npm install

npm run dev
```


Access the main app via `http://localhost:3000`