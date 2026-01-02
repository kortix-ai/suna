
**1. Launching the backend**

```
cd /backend
```

1.1 Launching REDIS for data caching


```bash
docker compose up redis
```


1.2 Running Temporal worker for workflow execution

**IMPORTANT**: Make sure you have Temporal Cloud credentials set in your `.env` file:
- `TEMPORAL_ADDRESS=us-west-2.aws.api.temporal.io:7233`
- `TEMPORAL_NAMESPACE=kortix-1.d5grr`
- `TEMPORAL_API_KEY=<your-api-key>`

```bash
uv run python -m core.temporal.worker
```

Or alternatively:
```bash
uv run core/temporal/worker.py
```

1.3 Running the main API server

```bash
uv run api.py
```

Or using uvicorn directly:
```bash
uv run uvicorn api:app --host 0.0.0.0 --port 8000 --reload
```

1.4 Running worker health check

```bash
uv run worker_health.py
```

**2. Launching the frontend**

```bash

cd frontend && npm install

npm run dev
```


Access the main app via `http://localhost:3000`