# Backend Servers For Web Projects

Use a real backend only when the site or app actually needs persistence, server-side APIs, streaming, or long-running state.

## When To Use A Backend

- forms that need to save or process data
- authenticated API calls
- websockets or SSE
- server-side orchestration or tool calls
- database-backed app state

## Local Workflow

1. Write a normal backend server in the project directory.
2. Start it with `pty_spawn`.
3. Verify it locally before wiring the frontend around it.
4. Keep API paths explicit and easy to switch between local and deployed environments.

### Example Commands

```bash
# Python / FastAPI
python api_server.py

# Node / Express
node server.js
```

Use `pty_read` to inspect logs and `pty_kill` when cleanup is needed.

## Frontend Connection Guidance

- Prefer explicit API base configuration instead of magic platform placeholders.
- Keep local verification working first.
- If the target repo has a real deploy/proxy setup, adapt the API base to that setup deliberately rather than assuming a specific platform proxy token.

## LLM and Media Features

If the backend depends on external AI APIs, require the matching environment variables explicitly and document them in the project. Read `shared/20-llm-api.md` before wiring those features.
