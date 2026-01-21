# Package Management

## Python (Backend)

**Always use `uv` instead of `pip`.**

```bash
# Add a dependency
uv add package-name

# Add dev dependency
uv add --dev package-name

# Sync dependencies
uv sync

# Run with uv
uv run python script.py
uv run pytest
```

**Why uv?**
- 10-100x faster than pip
- Better dependency resolution
- Lock file support
- Consistent across environments

## JavaScript/TypeScript (Frontend/Mobile)

**Use `bun` as the package manager.**

```bash
# Install dependencies
bun install

# Add a dependency
bun add package-name

# Add dev dependency
bun add -d package-name

# Run scripts
bun run dev
bun run build
```

## Monorepo Structure

```
agentpress/
├── backend/          # uv (Python)
│   └── pyproject.toml
├── apps/
│   ├── frontend/     # bun (TypeScript)
│   │   └── package.json
│   └── mobile/       # bun (TypeScript)
│       └── package.json
└── packages/
    └── shared/       # bun (TypeScript)
        └── package.json
```
