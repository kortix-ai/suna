# Repository Guidelines

## Project Structure & Module Organization
- `backend/` – Python 3.11 FastAPI service. Core logic in `backend/core/`; entry `backend/api.py`; background worker command targets `run_agent_background`. Tests live next to code in module `tests/` folders (see `backend/TESTING.md`).
- `frontend/` – Next.js app. Public assets in `frontend/public/`.
- `apps/mobile/` – Expo/React Native app.
- `sdk/` – Python SDK (`kortix/`), with examples in `sdk/example/`.
- `docs/` – Documentation. Other infra: `docker-compose.yaml`, `.github/` workflows.

## Build, Test, and Development Commands
- Docker stack (backend, worker, redis, frontend): `docker compose up --build`
- Backend install/run: `cd backend && uv sync && uv run api.py`
- Backend worker: `cd backend && uv run dramatiq run_agent_background`
- Backend tests: `cd backend && ./test --unit` (coverage: `./test --coverage`)
- Frontend dev: `cd frontend && npm install && npm run dev`
- Mobile dev: `cd apps/mobile && npm install && npm run start` (or `npm run ios|android|web`)
- One‑time setup and orchestration: `python setup.py`, then `python start.py`

## Coding Style & Naming Conventions
- Python: 4‑space indent, type hints where practical, `snake_case` for functions/vars, `PascalCase` for classes, modules as `snake_case.py`.
- JS/TS (frontend/mobile): Run `npm run format` (Prettier) and `npm run lint` (Next ESLint config). Components `PascalCase.tsx`, hooks `useX.ts`.
- Keep PRs focused and small; follow existing patterns in touched directories.

## Testing Guidelines
- Framework: `pytest` (see `backend/pyproject.toml`).
- Location: place tests in module `tests/` folders; name files `*.test.py`.
- Quick examples:
  - Run all: `cd backend && ./test`
  - Markers: `uv run pytest -m unit|integration|llm`
  - Coverage target: ~60% (`./test --coverage`)

## Commit & Pull Request Guidelines
- Use Conventional Commits: `feat(frontend): ...`, `fix(backend): ...`, `chore(sdk): ...`.
- PRs must include: clear description, linked issues, test plan; screenshots for UI changes; updated docs when applicable.
- Ensure `npm run lint && npm run format:check` (frontend) and backend tests pass before requesting review.

## Security & Configuration Tips
- Never commit secrets. Store env in `backend/.env` and `frontend/.env.local` (see `start.py` for detected keys and guidance).
- Local services: Redis via Docker; backend binds `:8000`, frontend `:3000`.

## Agent‑Specific Instructions
- Prefer `rg` for search; keep patches minimal and scoped.
- Follow this file’s rules for any code you touch within its directory tree.
