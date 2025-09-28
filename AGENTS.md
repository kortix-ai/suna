# Repository Guidelines

## Project Structure & Module Organization
- `backend/` – Python FastAPI API and worker (Dramatiq). Tests live near code under `tests/` folders. Uses `uv` and `pytest`.
- `frontend/` – Next.js/TypeScript app. Linting and formatting via ESLint/Prettier.
- `sdk/` – Python client (`adentic/`) with examples.
- `apps/mobile/` – React Native/Expo prototype.
- Root: `docker-compose.yaml`, `setup.py` (setup wizard), `start.py` (orchestrated start), `docs/`, `.github/`.

## Build, Test, and Development Commands
- Bootstrap (envs, services): `python setup.py` (run at repo root).
- Start full stack locally: `python start.py`.
- Backend (Docker): `cd backend && docker compose up --build`.
- Backend (local dev):
  - API: `cd backend && uv run api.py`
  - Worker: `cd backend && uv run dramatiq --processes 4 --threads 4 run_agent_background`
- Backend tests: `cd backend && ./test --unit` or `uv run pytest -m unit`.
- Frontend: `cd frontend && npm install && npm run dev`.
- Lint/format (FE): `cd frontend && npm run lint && npm run format:check`.

## Coding Style & Naming Conventions
- Python: PEP 8, 4‑space indent, type hints preferred, concise docstrings. Keep tests close to code. No enforced formatter in repo—keep imports tidy and readable.
- TypeScript/React: ESLint + Prettier (`eslint.config.mjs`, `.prettierrc`). PascalCase for components, camelCase for variables/functions, kebab-case for non-component files.
- Paths/files: keep module directories small and cohesive; avoid long index files.

## Testing Guidelines
- Framework: `pytest` with markers: `unit`, `integration`, `llm`, `asyncio`.
- Discovery: files `test_*.py` or `*.test.py` under `tests/`.
- Coverage: threshold 60% via `pytest.ini` (`--cov` enabled). HTML report at `backend/htmlcov/index.html`.
- Examples: `uv run pytest -m unit`, `./test --coverage`, `uv run pytest core/services/tests/cache.test.py`.

## Commit & Pull Request Guidelines
- Commits: use Conventional Commits like the history (`feat:`, `fix:`, `docs:`, `chore:`). Imperative mood, concise scope.
- PRs: include description, linked issues, backend test updates, and UI screenshots for FE changes. Ensure `npm run lint`, backend tests, and `docker compose` start clean locally. Keep PRs focused and update docs when behavior changes.

## Security & Configuration Tips
- Never commit secrets. Copy `.env.example` to `.env`/`.env.local` or run the setup wizard.
- When running API locally with Redis in Docker: `REDIS_HOST=localhost` (Docker‑to‑Docker: `redis`).

